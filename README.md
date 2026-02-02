## SIET Bus Tracking — Deep Workflow Guide

This README documents the _actual shipped system_ as on January 2026. No future roadmap items, no speculative features. Every section below traces how credentials are provisioned, how data flows through Firestore, how notifications are brokered, and how Google Maps renders live buses inside the Expo client.

---

## 1. Credential Provisioning & Auth Flow

### 1.1 CSV → Firestore Seeding (scripts/importCSV.js)

1. Admin drops the latest institute sheet under `Bus_data/BUS details(BUS 21).csv` (or adjusts the filename constant).
2. `node scripts/importCSV.js` loads `serviceAccountKey.json`, parses the sheet line by line, and splits it into: `students[]`, `staff.driver`, `staff.coadmin`.
3. Bus metadata is normalized (`normalizeBus()` strips whitespace, uppercases, and de-duplicates dashes) and stored under `buses/{busNumber}` with `routeStops`, `studentCount`, and timestamp.
4. Each student row becomes a `users/{registerNumber}` document with:

- `role: 'student'`, `password: name`, `busNumber`, `boardingPoint`, `year`, `department`, `remarks`.
- Mirror copy stored under `buses/{busNumber}/students/{registerNumber}` for bus-specific rosters.

5. Driver and co-admin credentials are seeded if their sections exist; both end up in `users/{userId}` with `role: 'driver'` or `role: 'coadmin'`, plus a `buses/{busNumber}/staff/{driver|coadmin}` reference.
6. All records carry `authenticated: true`, `status: 'Active'`, and `registeredAt` timestamps. No manual sign-up exists in the mobile app—login relies solely on these seeded docs.

### 1.2 Runtime Authentication (src/services/authService.js)

1. User enters credentials → `authService.login()` normalizes `userId`, optional `role`, and optional `busNumber`.
2. Firestore lookup happens in two passes: direct doc fetch (`doc(db,'users',userId)`) then fallback query (`where('userId','==',userId)`).
3. Guardrails enforced before success:

- Role match (`userData.role` vs client selection when provided).
- Password equality (`storedPassword === password`).
- Active status (rejects `status === 'inactive'`).
- Bus consistency when a bus is selected on the login screen (via `normalizeBusNumber`).

4. On success a session object is assembled with `uid`, `registerNumber`, `busId`, `selectedBus`, `email`, etc., persisted in AsyncStorage (`AUTH_TOKEN_KEY`, `CURRENT_USER_KEY`).
5. `updateLastLogin()` writes ISO timestamps back to Firestore, keeping audit trail current.
6. Push registration is triggered immediately: `registerPushTokenAsync(sessionUser)` stores or refreshes the device token under `users/{uid}`.
7. `authService.logout()` mirrors this by removing tokens (`removePushTokenForUser`) and clearing AsyncStorage.
8. Management accounts bypass Firestore entirely: credentials pulled from `CONFIG.MANAGEMENT_CREDENTIALS` (env-driven) and stored locally as `management-session`.

### 1.3 Session Maintenance

- `useFcmTokenManager()` listens to `AppState` and re-calls `registerPushTokenAsync` whenever the app re-enters foreground, ensuring the cached token never drifts.
- `AuthGuard` components gate navigation stacks by calling `authService.isAuthenticated()` and rehydrating the user profile from storage.

---

## 2. Notification Workflow

### 2.1 Device Token Lifecycle (src/services/pushNotificationService.js)

1. Permission handshake:

- Android → `PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS`.
- iOS → `messaging().requestPermission()`; both require statuses within `AUTHORIZED_STATUSES`.

2. Once granted, `messaging().getToken()` returns the FCM token; `persistTokenForUser()` writes it to `users/{uid}`:

- Ensures the user document exists (merge write with `role` + normalized `busNumber`).
- Updates `fcmTokens` (array union) and `lastFcmToken` fields.

3. `messaging().onTokenRefresh()` is wired so replacements automatically overwrite Firestore.
4. Logout or explicit cleanup → `removePushTokenForUser()` removes the token via `arrayRemove` and calls `messaging().deleteToken()` so Firebase can reissue later.

### 2.2 Server Relay (server/)

1. The Expo app hits `POST {SERVER_URL}/startBus` through `notifyBusTrackingStarted()` with payload `{ busNumber, driverName, initiatedBy, excludeToken }`.
2. `server/src/routes/busRoutes.js` validates payload, then calls `sendBusStartNotification()`.
3. `sendBusStartNotification()` assembles recipients:

- `getRecipientsByBus(busNumber)` fetches every `users` doc whose `role` is in `['student','coadmin','incharge']` and shares the normalized bus number.
- `getRecipientsByRole('management')` ensures admin staff see every alert.
- Initiator’s tokens and explicit `excludeToken` are removed so the driver isn’t double-notified.

4. Firebase Admin’s `sendEachForMulticast()` delivers the payload built by `buildMessagePayload()` (`title: Bus {n} is now live`, `type: BUS_START`, `tracking-alerts` channel, APNs category `tracking-alerts`).
5. Failed tokens— especially `messaging/registration-token-not-registered`— trigger `pruneInvalidTokens()` which removes dead entries from Firestore to keep the roster tight.
6. For direct person-to-person alerts the mobile client calls `POST /notify`. The same service resolves `users/{uid}.fcmTokens` and multicasts to only that user.

### 2.3 Foreground Handling

- `subscribeToForegroundNotifications()` pipes `messaging().onMessage` events into in-app handlers so dashboards can surface toast banners.
- `subscribeToNotificationOpens()` + `getInitialNotification()` let navigation deep-link into screens when a push is tapped.

---

## 3. Location + Maps Flow

### 3.1 Driver Tracking Pipeline

1. Driver authenticates (see §1) → device token registered.
2. Start tracking button triggers `backgroundLocationService.startForegroundTask()`:

- Requests `expo-location` foreground + `expo-task-manager` background permissions.
- Registers `driver-background-location-task`, ensuring the OS wakes the app even when minimized.

3. Each GPS sample runs through `locationService.updateBusLocation()`:

- Validates `isTracking` flag and active session IDs.
- Rejects jitter (`distance < 20m` or `timestamp diff < 4s`).
- Normalizes lat/lng and writes to Firestore under `tracking/{busNumber}` (actual collection defined in `locationService`).

4. `subscribeToBusLocation()` abstracts Firestore listeners so `BusLiveTrackingScreen` and management dashboards receive real-time snapshots (`currentLocation`, `speed`, `heading`, `driverName`).
5. Session termination toggles `isTracking=false`, which removes markers and stops notifications without deleting history.

### 3.2 Google Maps Rendering (src/screens/BusLiveTrackingScreen.js & related)

1. Map component uses `react-native-maps` with `PROVIDER_GOOGLE`, `cameraRef`, and Expo’s SafeArea layout.
2. Initial region targets the latest bus coordinate or defaults to `SIET_CENTER` (11.0168, 76.9558).
3. `Polyline` strokes are built from `SAMPLE_STOPS` or Firestore-sourced routes when available; styling: `strokeColor=COLORS.accent`, `lineDashPattern=[1,1]`, `geodesic=true`.
4. Bus markers:

- `toLngLat()` ensures React Native Maps receives numbers.
- UI is purely presentational (custom view compositions) while logic stays untouched.

5. Stop markers iterate `SAMPLE_STOPS` to show the same red drop pins as the reference design.
6. Camera helpers:

- `animateToCoordinate()` rotates/zooms toward the latest bus heading.
- `fitPoints()` frames either the live bus + stops or stops alone.

7. Control buttons (`Center Bus`, `View Route`) call these helpers; disabled states and colors come from `COLORS` constants.

---

## 4. Reporting & Attendance (Actual Behaviors)

### 4.1 Student / Bus Incharge Reports

1. Students open `StudentReportScreen`, choose recipient role, and submit via `reportsService.submitReport()`.
2. Firestore document fields: `recipientRole`, `busNumber`, `studentMeta`, `message`, `timestamp`.
3. Bus incharge dashboards (`BusInchargeReportScreen`) filter by `recipientRole='busIncharge'` and normalized `busNumber`.
4. Respond & Clear button triggers `reportsService.respondToReport()` → sends acknowledgement, then deletes the Firestore doc to avoid duplicates.
5. Management reports board uses the same service but with `recipientRole='management'` and cross-bus scope.

### 4.2 Attendance Tracking

1. `attendanceService.js` reads bus rosters from `buses/{busNumber}/students`.
2. Marking attendance writes to dedicated Firestore collections with `sessionId`, `timestamp`, and `present[]` arrays.
3. Historical views (`AttendanceHistoryScreen`, `ManagementAttendanceHistory`) pull aggregate counts with Firestore queries sorted by `createdAt`.

---

## 5. Codebase Layout (Current)

```
sietbusapp/
├── App.js                      # Expo root with font/theme bootstrapping
├── index.js                    # Entry for Expo runtime
├── app.config.js / app.json    # Manifest + env wiring
├── eas.json                    # EAS build profiles (dev / preview / prod)
├── assets/                     # Fonts + static images
├── Bus_data/                   # CSV payloads consumed by the seeder
├── scripts/importCSV.js        # Credential + roster importer
├── server/                     # Express relay for notifications
└── src/
   ├── components/             # Auth guards, bottom navs, shared UI
   ├── hooks/                  # `useFcmTokenManager`, etc.
   ├── navigation/             # `AppNavigator.js` (role-based stacks)
   ├── screens/                # Attendance, reports, dashboards, map views
   ├── services/
   │   ├── authService.js      # Login/logout/token persistence
   │   ├── locationService.js  # GPS writes + subscriptions
   │   ├── backgroundLocationService.js
   │   ├── pushNotificationService.js
   │   ├── attendanceService.js / reportsService.js
   │   └── api.js, backendClient.js, storage helpers
   └── utils/                  # Constants, bus number normalization, etc.
```

---

## 6. Environment & Execution (Only What Exists)

### Mobile Client

1. Install deps: `npm install` inside `sietbusapp`.
2. Configure `.env` with Expo-prefixed Firebase keys and management login defaults.
3. Launch dev client: `npx expo start --dev-client` (QR or emulator). This is mandatory because the project depends on native modules (`@react-native-firebase/messaging`).
4. Optional native builds:

- `npm run android` → `expo run:android` (Gradle debug build in `/android`).
- `npm run ios` → `expo run:ios` (requires macOS + Xcode).

### Notification Relay (server/)

1. `cd server && npm install`.
2. Configure `.env` with:

- `PORT` (default 4000).
- `FIREBASE_SERVICE_ACCOUNT_PATH` pointing to the Admin JSON key.
- Optional `ALLOWED_ORIGINS` for CORS.

3. Run `npm run dev` (nodemon) or `npm start`.
4. Point the mobile client’s `EXPO_PUBLIC_NOTIFICATION_SERVER_URL` to this server (`http://10.0.2.2:4000` for Android emulator, LAN IP for devices).

### CSV Seeder

1. Place Admin key in repo root as `serviceAccountKey.json`.
2. Ensure desired CSV file resides under `Bus_data/` and the filename constant matches.
3. Execute `node scripts/importCSV.js`. Logs report student counts and which roles were created; sample docs are printed for quick manual verification.

---

## 7. Interview-Ready Talking Points

- **Credential lifecycle** — “We never create accounts inside the app. Instead, the transport office exports a CSV per bus. Our Node seeder reads that file, normalizes identifiers, and writes both `users/{registerNumber}` and `buses/{bus}/students/{registerNumber}` documents. That means drivers, students, and co-admins get deterministic passwords (students use their names) and the mobile client only exposes a login form.”
- **Auth enforcement** — “When someone logs in the app hits Firestore, validates role, password, status, and bus assignment, then stores a signed session locally. Every success path also renews their FCM token so push routing is always accurate.”
- **Notification routing** — “Drivers call `POST /startBus`. The Express relay grabs everyone who belongs to that bus (students + incharge) plus management, strips out the driver’s own token, and uses Firebase Admin `sendEachForMulticast` to push the alert. Dead tokens get removed immediately so Firestore stays clean.”
- **Maps + tracking** — “Drivers run a background task that streams sanitized GPS points. Map screens subscribe to that Firestore document, animate the Google Maps camera, and render custom markers/stops. Routing polylines are precomputed using OSRM or fall back to straight segments if networking fails.”
- **Reports + attendance** — “Reports are Firestore docs keyed by recipient role. Responding deletes the doc so nothing lingers. Attendance uses the seeded roster under each bus doc, so marking presence is just mutating per-session documents.”

This README mirrors the production build as shipped—no future work items and no feature drift.

# SIET Bus Tracking System`````# SIET Bus Tracking System# SIET Bus Tracking System

A React Native + Expo application that powers real-time tracking for the Sri Shakthi Institute bus fleet. The app targets four personas—students, bus incharge staff, drivers, and management—and synchronises data with Firebase for authentication, storage, and live location updates.Real-time GPS bus tracking with smooth animations for students, drivers, and management.A comprehensive React Native mobile application for real-time bus tracking with separate interfaces for drivers, students, and management.

---## Features## � Features

## Current Status (October 2025)- **Smooth animated bus movement** - No jumping markers

- ✅ "Co-Admin" role renamed to **Bus Incharge** across navigation, screens, and services.

- ✅ Live map (`MapScreen`) renders OpenStreetMap tiles, OSRM-generated polylines, and a draggable stop timeline showing **current** and **next** stops.- **Real-time path trail** - See the exact route traveled### Driver Portal

- ✅ Driver workflow publishes foreground/background GPS points to Firestore through `backgroundLocationService`.

- ✅ Management & Bus Incharge dashboards consume the same Firestore feed to display bus, driver, and student data.- **Auto-follow camera** - Camera rotates with bus direction

- ✅ CSV onboarding script seeds buses, drivers, and students.

- ⚠️ Pending: finish onboarding for 30+ buses, move Google Maps/third-party keys into `.env`, and add automated tests.- **Live GPS updates** - Updates every 2 seconds- Real-time GPS tracking with live location updates

---- **Bus heading rotation** - Marker shows direction of travel- Start/Stop tracking functionality

## Personas & Feature Highlights- Driver authentication and profile management

- **Students**
  - Unified login with bus selection.## Quick Start

  - Live map with ETA labels, stop timeline, and attendance history.

  - Report/feedback flows tied to Firestore collections.````bash### Student Portal

- **Bus Incharge (formerly Co-Admin)**
  - Dashboard shortcuts for bus, driver, student, attendance, map, and reporting.npm install

  - Bottom navigation (`BusInchargeBottomNav`) for Home / Track / Profile.

  - Report composer (`BusInchargeReportScreen`) stores submissions for management review.npx expo start- Track assigned bus in real-time

- **Drivers**
  - Start/stop tracking via Expo Location + Task Manager.```- View bus location on interactive map

  - Background task (`driver-background-location-task`) keeps updates flowing when minimised.

  - Profile management and attendance utilities.- Real-time status updates

- **Management**
  - Fleet-wide dashboards, attendance history, analytics, and report handling.## Tech Stack

  - CSV based onboarding and bus assignment tools.

- React Native + Expo### Management Portal

---

- Firebase Firestore (real-time sync)

## Live Tracking Stack

- **Map Rendering:** `react-native-maps` with OpenStreetMap `UrlTile` overlay.- Google Maps with animations- Monitor all buses in real-time

- **Routing:** `utils/routePolylineConfig.js` defines default stops and builds OSRM URLs (`buildOsrmRouteUrl`). Response geometry drives the polyline rendered on the map.

- **Progress Engine:** `MapScreen` computes nearest stop, arrival thresholds, ETA labels, and animates a bottom sheet that expands to reveal the full stop list.- Expo Location (GPS tracking)- Live tracking dashboard for each bus

- **Data Source:** Firestore `buses/{busNumber}` document updated by drivers through `updateBusLocation`.

- **Throttling:** Updates below 20 m movement or 4 s interval are skipped to reduce Firestore writes.- Driver and student management

---## GPS Settings- Bus fleet management

## Services & Data Flow- Accuracy: BestForNavigation- Reports and analytics

- **Authentication (`src/services/authService.js`)**
  - Role-aware login (student, driver, bus incharge, management) with bus number validation.- Update interval: 2 seconds

  - AsyncStorage persistence for offline resume and session caching.

- **Location (`src/services/locationService.js` & `backgroundLocationService.js`)**- Distance threshold: 5 meters## 📁 Project Structure
  - Normalises bus IDs (e.g. `SIET--005` → `SIET-005`).

  - Tracks active driver sessions, prevents stale updates, and supports background execution.- Smooth marker animation: 1000ms

- **Attendance & Reports:** Dedicated services manage Firestore reads/writes for attendance history and report escalations.

- **Media Handling:** `cloudinaryService.js` prepares image uploads if Cloudinary credentials are supplied.````

- **CSV Import (`scripts/importCSV.js`)**
  - Parses institute CSVs (`Bus_data/`) and writes bus, driver, and student documents.## Rolessietbusapp/

  - Requires `serviceAccountKey.json` (Firebase Admin) at the project root.

- **Driver**: Start/stop tracking with enhanced GPS├── App.js # Main app entry point

---

- **Student**: See bus with smooth movement + path trail├── index.js # App registration

## Project Layout

`````- **Admin**: Monitor all buses with auto-follow camera├── app.json # Expo configuration

sietbusapp/

├── App.js                     # Expo bootstrap & font loading├── package.json # Dependencies

├── app.json                   # Expo application manifest├── firestore.rules # Firebase security rules

├── package.json               # Scripts & dependencies├── assets/ # Images and static files

├── assets/                    # Images and static content└── src/

├── Bus_data/                  # Source CSVs for onboarding├── components/ # Reusable UI components

├── scripts/importCSV.js       # Firestore import utility│ ├── ui/ # Base UI components (Button, Card, Input)

├── android/                   # Generated native Android project│ ├── AuthGuard.js

└── src/│ └── AuthStatus.js

    ├── components/            # Shared UI & navigation elements├── navigation/ # Navigation configuration

    ├── navigation/AppNavigator.js│ └── AppNavigator.js

    ├── screens/               # >30 persona-specific screens├── screens/ # All app screens

    ├── services/              # Firebase, auth, attendance, reports, location│ ├── Driver screens (Dashboard, Login, Signup)

    └── utils/                 # Constants, polyline config, helpers│ ├── Student screens (Dashboard, Login, Signup)

```│ ├── Management screens (Dashboard, Login)

│ ├── MapScreen.js (Student tracking)

---│ ├── BusLiveTrackingScreen.js (Admin tracking)

│ └── Shared screens

## Prerequisites├── services/ # Backend services

- Node.js 18+│ ├── authService.js # Authentication

- Expo CLI (`npm install -g expo-cli`) and Expo Dev Client installed on device/emulator│ ├── locationService.js # GPS & Firestore location

- Android Studio / Xcode for native builds│ ├── firebaseConfig.js # Firebase setup

- Firebase project with Firestore & Auth enabled│ └── storage.js # Local storage

└── utils/ # Utility functions

---└── constants.js # App constants (colors, etc.)



## Getting Started````

1. **Clone & Install**

   ```bash## �️ Technologies

   git clone https://github.com/HSbeast23/Siet-Bus-Tracking.git

   cd Siet-Bus-Tracking/sietbusapp- **React Native** - Mobile app framework

   npm install- **Expo** - Development platform

   ```- **Firebase Firestore** - Real-time database

2. **Configure Environment Variables** (`.env` in project root)- **Firebase Auth** - User authentication

   ```env- **Expo Location** - GPS tracking

   EXPO_PUBLIC_FIREBASE_API_KEY=...- **React Navigation** - Navigation system

   EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=...- **React Native Maps** - Map integration

   EXPO_PUBLIC_FIREBASE_PROJECT_ID=...

   EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=...## 📦 Installation

   EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...

   EXPO_PUBLIC_FIREBASE_APP_ID=...1. **Clone the repository**

   EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID=...

   EXPO_PUBLIC_MANAGEMENT_USERNAME=...```bash

   EXPO_PUBLIC_MANAGEMENT_PASSWORD=...git clone <repository-url>

   EXPO_PUBLIC_COADMIN_EMAIL=...cd siet-bus-tracking/siet/sietbusapp

   EXPO_PUBLIC_COADMIN_PASSWORD=...````

   EXPO_PUBLIC_COADMIN_NAME=...

   EXPO_PUBLIC_COADMIN_BUS_ID=...2. **Install dependencies**

`````

> Store mapping or other platform keys as `EXPO_PUBLIC_*` entries so `babel-plugin-dotenv-import` can inject them.```bash

3. **Run Locally**npm install

   `bash`

   npx expo start --dev-client

   ```3. **Configure environment variables**

   Press `a` (Android) or `i` (iOS) to launch an emulator, or scan the QR with the Expo dev client.   Create a `.env` file with your Firebase credentials:
   ```

---```env

EXPO_PUBLIC_FIREBASE_API_KEY=your_api_key

## Native Build & Rebuild PolicyEXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=your_auth_domain

- Install native modules with `npx expo install <package>`.EXPO_PUBLIC_FIREBASE_PROJECT_ID=your_project_id

- After adding a module (e.g. `expo-mail-composer`), rebuild the dev client or standalone binary:EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=your_storage_bucket

  ````bashEXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id

  npx expo run:androidEXPO_PUBLIC_FIREBASE_APP_ID=your_app_id

  npx expo run:ios        # macOS onlyEXPO_PUBLIC_FIREBASE_MEASUREMENT_ID=your_measurement_id

  # or Expo Cloud```

  eas build --platform android --profile development

  ```4. **Start the development server**

  ````

- Expo Go includes most Expo SDK modules; rebuild is only required when using the custom dev client.

```bash

---npx expo start

```

## Firestore Seeding Workflow

1. Place `serviceAccountKey.json` (Firebase Admin credential) in the project root.5. **Run the app**

2. Drop institute CSV exports into `Bus_data/` and update `CSV_FILENAME` when needed.

3. Execute:- Scan QR code with Expo Go app (Android/iOS)

   ```bash- Press `a` for Android emulator

   node scripts/importCSV.js- Press `i` for iOS simulator

   ```

   This writes/updates documents in `buses/`, `users/`, and nested subcollections so the app can reference them immediately.## � Configuration
   ```

---### Firebase Setup

## Troubleshooting1. Create a Firebase project

- **Cannot find native module `ExpoMailComposer`** – rebuild the dev client after installing the dependency.2. Enable Firestore and Authentication

- **Polyline degraded to straight segments** – OSRM fetch failed; the app logs `routeWarning`. Validate the public OSRM endpoint or host your own instance.3. Add your Firebase config to `.env`

- **Blank OSM tiles** – check connectivity or switch to a different tile server if rate limited.4. Deploy Firestore security rules from `firestore.rules`

- **Location not updating** – ensure the driver granted both foreground and background permissions via `ensureLocationPermissionsAsync()`.

### Location Permissions

---

The app requires location permissions for GPS tracking. Permissions are requested at runtime.

## Roadmap

1. Seed the remaining bus routes and expose a selector for multi-route tracking.## 📱 User Roles

2. Harden authentication (password reset, account recovery) and migrate credentials to secure storage.

3. Introduce automated tests (Jest for services, Detox/E2E for critical flows).### Driver

4. Externalise secrets to Expo EAS (build profiles) and set up CI/CD.

5. Add analytics dashboards for punctuality, occupancy, and route performance.- Start/stop location tracking

- View current location

---- Manage profile

## License & Support### Student

This repository is maintained for the SIET internal transport team. Contact the maintainer group for reuse or distribution questions.

- View assigned bus location
- Track bus in real-time
- View bus status (active/inactive)

### Management

- Monitor all buses
- View live tracking for any bus
- Manage drivers and students
- Access reports and analytics

## � Security

- Firebase Authentication for user management
- Firestore security rules for data protection
- Bus number normalization for data consistency
- Real-time validation and error handling

## 📊 Key Features

### Real-Time GPS Tracking

- Updates every 5 seconds
- 10-meter distance threshold
- Automatic normalization of bus numbers
- Active/inactive status tracking

### Live Map Visualization

- Interactive maps for students and admin
- Real-time bus marker updates
- Status indicators
- Last updated timestamp

### Normalized Bus Numbers

All bus numbers are automatically normalized:

- Converts to uppercase
- Collapses multiple hyphens to single hyphen
- Example: "siet--005" → "SIET-005"

## � Status Indicators

- ✅ **Active** - Bus is currently tracking
- ⏸️ **Inactive** - Bus tracking stopped
- ⏳ **Waiting** - Waiting for bus to start tracking

## 🐛 Troubleshooting

### Location not updatingz

### Map not showing

- Check internet connection
- Verify Firestore rules allow read access
- Ensure bus is actively tracking

## 📄 License

This project is for educational purposes.

## 👥 Support

For issues or questions, please contact Haarhish .
Whatsapp number : 7695908575.
