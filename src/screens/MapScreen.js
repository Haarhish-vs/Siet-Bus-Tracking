import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ActivityIndicator,
	Alert,
	Animated,
	Dimensions,
	PanResponder,
	ScrollView,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Polyline, Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../utils/constants';
import { authService } from '../services/authService';
import { normalizeBusNumber, subscribeToBusLocation } from '../services/locationService';
import {
	DEFAULT_ROUTE_STOPS,
	buildOsrmRouteUrl,
	stopsToLatLng,
} from '../utils/routePolylineConfig';

const EDGE_PADDING = { top: 72, right: 48, bottom: 120, left: 48 };
const DEFAULT_ZOOM_LEVEL = 12;
const SIET_CENTER = { latitude: 11.0168, longitude: 76.9558 };
const MIN_PAN_PADDING = 48;

const toLngLat = (point = {}) => ({ latitude: Number(point.latitude) || 0, longitude: Number(point.longitude) || 0 });

const computeBounds = (points = []) => {
	if (!points.length) {
		return null;
	}

	const lats = points.map((pt) => pt.latitude);
	const lngs = points.map((pt) => pt.longitude);
	const northEast = [Math.max(...lngs), Math.max(...lats)];
	const southWest = [Math.min(...lngs), Math.min(...lats)];
	return { northEast, southWest };
};

const normaliseRouteStops = (rawStops) => {
	if (!Array.isArray(rawStops)) {
		return DEFAULT_ROUTE_STOPS;
	}

	const cleaned = rawStops
		.map((stop, index) => {
			if (!stop) {
				return null;
			}

			const latitude = Number(stop.latitude ?? stop.lat);
			const longitude = Number(stop.longitude ?? stop.lng);
			if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
				return null;
			}

			const name = (stop.name || stop.label || stop.stopName || `Stop ${index + 1}`).toString().trim();
			const id = stop.id || name || `stop-${index + 1}`;

			return {
				id,
				name,
				latitude,
				longitude,
			};
		})
		.filter(Boolean);

	return cleaned.length ? cleaned : DEFAULT_ROUTE_STOPS;
};

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_COLLAPSED_HEIGHT = 150;
const SHEET_EXPANDED_HEIGHT = Math.min(420, SCREEN_HEIGHT * 0.62);
const ARRIVAL_DISTANCE_THRESHOLD = 140; // meters
const STOP_STATUS_COLORS = {
	completed: '#34D399',
	current: '#F59E0B',
	next: '#38BDF8',
	upcoming: 'rgba(255,255,255,0.35)',
};

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const toRad = (value) => (value * Math.PI) / 180;
const haversineDistance = (pointA = {}, pointB = {}) => {
	const { latitude: lat1, longitude: lon1 } = pointA;
	const { latitude: lat2, longitude: lon2 } = pointB;
	if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
		return Number.POSITIVE_INFINITY;
	}

	const EARTH_RADIUS = 6371000; // metres
	const deltaLat = toRad(lat2 - lat1);
	const deltaLon = toRad(lon2 - lon1);
	const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(deltaLon / 2) ** 2;
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return EARTH_RADIUS * c;
};

export const BusMarker = ({ coordinate, label }) => (
	<Marker
		coordinate={coordinate}
		title={label}
		description="Bus Location"
	>
		<View style={styles.busMarkerGroup}>
			<View style={styles.busMarkerCircle}>
				<Text style={styles.busMarkerEmoji}>🚌</Text>
			</View>
			<View style={styles.busMarkerLabel}>
				<Text style={styles.busMarkerLabelText}>{label}</Text>
			</View>
		</View>
	</Marker>
);

const MapScreen = ({ route, navigation }) => {
	const cameraRef = useRef(null);

	const [mapReady, setMapReady] = useState(false);
	const [routeStops, setRouteStops] = useState(DEFAULT_ROUTE_STOPS);
	const [osrmPolyline, setOsrmPolyline] = useState([]);
	const [fetchingRoute, setFetchingRoute] = useState(false);
	const [routeWarning, setRouteWarning] = useState('');

	const [role, setRole] = useState('student');
	const [busDisplayName, setBusDisplayName] = useState('');
	const [busId, setBusId] = useState('');

	const [busLocation, setBusLocation] = useState(null);
	const [isBusTracking, setIsBusTracking] = useState(false);
	const [studentLocation, setStudentLocation] = useState(null);
	const [loading, setLoading] = useState(true);
	const sheetHeight = useRef(new Animated.Value(SHEET_COLLAPSED_HEIGHT)).current;
	const sheetStartHeightRef = useRef(SHEET_COLLAPSED_HEIGHT);
	const sheetExpandedRef = useRef(false);
	const [sheetExpanded, setSheetExpanded] = useState(false);

	const busMarkerLabel = useMemo(() => {
		const raw = (busDisplayName || '').trim() || busId || 'Bus';
		return raw.replace(/-+/g, '-');
	}, [busDisplayName, busId]);

	const busSpeed = Number(busLocation?.speed ?? 0);

	const initialRegion = useMemo(() => {
		const firstStop = routeStops[0];
		if (!firstStop) {
			return {
				latitude: 11.04104,
				longitude: 77.07738,
				latitudeDelta: 0.2,
				longitudeDelta: 0.2,
			};
		}

		return {
			latitude: firstStop.latitude,
			longitude: firstStop.longitude,
			latitudeDelta: 0.12,
			longitudeDelta: 0.12,
		};
	}, [routeStops]);

	const routeOnlyCoordinates = useMemo(() => stopsToLatLng(routeStops), [routeStops]);
	const routePolylineShape = useMemo(
		() => ({
			type: 'Feature',
			geometry: {
				type: 'LineString',
				coordinates: osrmPolyline.map((point) => [point.longitude, point.latitude]),
			},
			properties: {},
		}),
		[osrmPolyline]
	);
	const hasRouteShape = routePolylineShape.geometry.coordinates.length > 1;

	const fitPointsWithCamera = useCallback(
		(points) => {
			if (!cameraRef.current || !points.length) {
				return;
			}
			const bounds = computeBounds(points);
			if (!bounds) {
				return;
			}
			const padding = Math.max(
				EDGE_PADDING.top,
				EDGE_PADDING.right,
				EDGE_PADDING.bottom,
				EDGE_PADDING.left,
				MIN_PAN_PADDING
			);
			cameraRef.current.fitBounds(bounds.northEast, bounds.southWest, padding, 600);
		},
		[cameraRef]
	);

	const animateToCoordinate = useCallback((coordinate) => {
		if (!cameraRef.current || !coordinate) {
			return;
		}
		cameraRef.current.setCamera({
			centerCoordinate: toLngLat(coordinate),
			zoomLevel: 16,
			animationDuration: 600,
		});
	}, []);

	const allMapPoints = useMemo(() => {
		const points = [...routeOnlyCoordinates];
		if (busLocation) {
			points.push(busLocation);
		}
		if (studentLocation) {
			points.push(studentLocation);
		}
		return points;
	}, [routeOnlyCoordinates, busLocation, studentLocation]);

	const routeProgress = useMemo(() => {
		if (!routeStops.length) {
			return { stops: [], currentIndex: -1, nextIndex: -1 };
		}

		const enrichedStops = routeStops.map((stop) => ({
			...stop,
			distanceMeters: busLocation ? haversineDistance(busLocation, stop) : null,
		}));

		if (!busLocation || !isBusTracking) {
			return {
				stops: enrichedStops.map((stop, index) => ({
					...stop,
					status: index === 0 ? 'next' : 'upcoming',
					etaLabel: stop.time ? `ETA ${stop.time}` : 'Upcoming stop',
				})),
				currentIndex: -1,
				nextIndex: enrichedStops.length ? 0 : -1,
			};
		}

		const distances = enrichedStops.map((stop) =>
			typeof stop.distanceMeters === 'number' ? stop.distanceMeters : Number.POSITIVE_INFINITY
		);

		let nearestIndex = distances.reduce(
			(best, distance, idx) => (distance < distances[best] ? idx : best),
			0
		);
		const nearestDistance = distances[nearestIndex];

		const isAtStop = nearestDistance <= ARRIVAL_DISTANCE_THRESHOLD;
		const currentIndex = isAtStop ? nearestIndex : -1;
		let nextIndex = isAtStop ? nearestIndex + 1 : nearestIndex;
		if (nextIndex >= enrichedStops.length) {
			nextIndex = -1;
		}
		const lastCompletedIndex = Math.max(nearestIndex - 1, -1);

		const etaForDistance = (distance) => {
			if (!Number.isFinite(distance)) {
				return '';
			}
			if (busSpeed <= 0.5) {
				return 'Awaiting movement';
			}
			const minutes = Math.max(Math.round((distance / Math.max(busSpeed, 0.1)) / 60), 1);
			return minutes <= 1 ? 'Arriving now' : `Arriving in ${minutes} min`;
		};

		const decoratedStops = enrichedStops.map((stop, idx) => {
			let status = 'upcoming';
			if (idx <= lastCompletedIndex) {
				status = 'completed';
			}
			if (isAtStop && idx === nearestIndex) {
				status = 'current';
			} else if (idx === nextIndex) {
				status = 'next';
			}

			let etaLabel = '';
			switch (status) {
				case 'completed':
					etaLabel = stop.time ? `Departed at ${stop.time}` : 'Departed';
					break;
				case 'current':
					etaLabel = 'At stop';
					break;
				case 'next':
					etaLabel = etaForDistance(stop.distanceMeters);
					break;
				default:
					etaLabel = stop.time ? `Scheduled ${stop.time}` : 'Upcoming stop';
			}

			return {
				...stop,
				status,
				etaLabel,
			};
		});

		return { stops: decoratedStops, currentIndex, nextIndex };
	}, [routeStops, busLocation, isBusTracking, busSpeed]);

	const currentStop = routeProgress.currentIndex >= 0 ? routeProgress.stops[routeProgress.currentIndex] : null;
	const nextStop = routeProgress.nextIndex >= 0 ? routeProgress.stops[routeProgress.nextIndex] : null;
	const routeHasStops = routeProgress.stops.length > 0;
	const isRouteCompleted =
		routeHasStops &&
		routeProgress.nextIndex === -1 &&
		routeProgress.currentIndex >= routeProgress.stops.length - 1;

	const summaryCurrentName = currentStop?.name || (isBusTracking ? 'En route' : 'Awaiting GPS fix');
	const summaryCurrentEta = currentStop?.etaLabel || (routeHasStops ? 'Waiting for live update' : 'Add route stops');
	const summaryNextName = isRouteCompleted
		? 'Route complete'
		: nextStop?.name || (routeHasStops ? routeProgress.stops[0].name : 'No upcoming stop');
	const summaryNextEta = isRouteCompleted
		? 'All stops covered'
		: nextStop?.etaLabel || (routeHasStops ? 'Awaiting departure' : 'Add route stops');
	const summaryCurrentEtaColor = currentStop ? '#34D399' : 'rgba(226,232,240,0.7)';
	const summaryNextEtaColor = isRouteCompleted
		? '#60A5FA'
		: nextStop
			? '#38BDF8'
			: 'rgba(226,232,240,0.7)';

	const animateSheet = useCallback(
		(expand) => {
			const target = expand ? SHEET_EXPANDED_HEIGHT : SHEET_COLLAPSED_HEIGHT;
			sheetExpandedRef.current = expand;
			setSheetExpanded(expand);
			Animated.spring(sheetHeight, {
				toValue: target,
				useNativeDriver: false,
				damping: 18,
				stiffness: 140,
			}).start();
		},
		[sheetHeight]
	);

	const handleSheetToggle = useCallback(() => {
		animateSheet(!sheetExpandedRef.current);
	}, [animateSheet]);

	const panResponder = useMemo(
		() =>
			PanResponder.create({
				onMoveShouldSetPanResponder: (_, gesture) => {
					if (Math.abs(gesture.dy) <= Math.abs(gesture.dx) || Math.abs(gesture.dy) <= 6) {
						return false;
					}
					if (!sheetExpandedRef.current && gesture.dy < 0) {
						return true;
					}
					if (sheetExpandedRef.current && gesture.dy > 0) {
						return true;
					}
					return false;
				},
				onPanResponderGrant: () => {
					sheetStartHeightRef.current = sheetExpandedRef.current
						? SHEET_EXPANDED_HEIGHT
						: SHEET_COLLAPSED_HEIGHT;
				},
				onPanResponderMove: (_, gesture) => {
					const nextHeight = clamp(
						sheetStartHeightRef.current - gesture.dy,
						SHEET_COLLAPSED_HEIGHT,
						SHEET_EXPANDED_HEIGHT
					);
					sheetHeight.setValue(nextHeight);
				},
				onPanResponderRelease: (_, gesture) => {
					const projectedHeight = clamp(
						sheetStartHeightRef.current - gesture.dy,
						SHEET_COLLAPSED_HEIGHT,
						SHEET_EXPANDED_HEIGHT
					);
					const midpoint = (SHEET_COLLAPSED_HEIGHT + SHEET_EXPANDED_HEIGHT) / 2;
					animateSheet(projectedHeight > midpoint);
				},
				onPanResponderTerminate: () => {
					animateSheet(sheetExpandedRef.current);
				},
			}),
		[animateSheet, sheetHeight]
	);

	const actionButtonsBottom = useMemo(
		() =>
			sheetHeight.interpolate({
				inputRange: [SHEET_COLLAPSED_HEIGHT, SHEET_EXPANDED_HEIGHT],
				outputRange: [SHEET_COLLAPSED_HEIGHT + 24, SHEET_EXPANDED_HEIGHT + 24],
				extrapolate: 'clamp',
			}),
		[sheetHeight]
	);

	const ensureStudentLocation = useCallback(async () => {
		try {
			const permission = await Location.requestForegroundPermissionsAsync();
			if (permission.status !== 'granted') {
				return;
			}

			const currentPosition = await Location.getCurrentPositionAsync({
				accuracy: Location.Accuracy.Balanced,
			});

			if (currentPosition?.coords) {
				setStudentLocation({
					latitude: currentPosition.coords.latitude,
					longitude: currentPosition.coords.longitude,
				});
			}
		} catch (error) {
			console.error('Unable to determine current location', error);
		}
	}, []);

	const fetchOsrmPolyline = useCallback(async (stops) => {
		if (!Array.isArray(stops) || stops.length < 2) {
			setOsrmPolyline(stopsToLatLng(stops));
			return;
		}

		const url = buildOsrmRouteUrl(stops);
		if (!url) {
			setOsrmPolyline(stopsToLatLng(stops));
			setRouteWarning('Cannot build OSRM request – showing straight segments.');
			return;
		}

		try {
			setFetchingRoute(true);
			setRouteWarning('');

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`OSRM request failed with status ${response.status}`);
			}

			const json = await response.json();
			const geometry = json?.routes?.[0]?.geometry?.coordinates;
			if (!Array.isArray(geometry)) {
				throw new Error('OSRM response missing geometry.');
			}

			setOsrmPolyline(
				geometry.map(([longitude, latitude]) => ({ latitude, longitude }))
			);
		} catch (error) {
			console.error('Failed to fetch OSRM polyline', error);
			setOsrmPolyline(stopsToLatLng(stops));
			setRouteWarning('OSRM unreachable. Displaying straight-line fallback.');
		} finally {
			setFetchingRoute(false);
		}
	}, []);

	useEffect(() => {
		if (routeStops.length) {
			fetchOsrmPolyline(routeStops);
		}
	}, [routeStops, fetchOsrmPolyline]);

	useEffect(() => {
		let unsubscribeFromBus = null;

		const initialise = async () => {
			setLoading(true);
			try {
				const currentUser = await authService.getCurrentUser();
				const resolvedRole = (route?.params?.role || currentUser?.role || 'student').toLowerCase();
				setRole(resolvedRole);

				const providedStops = normaliseRouteStops(route?.params?.routeStops);
				setRouteStops(providedStops);

				const rawBus =
					route?.params?.busId ||
					route?.params?.busNumber ||
					route?.params?.busDisplayName ||
					currentUser?.busId ||
					currentUser?.busNumber ||
					'';
				const normalizedBus = normalizeBusNumber(rawBus);
				if (normalizedBus) {
					setBusId(normalizedBus);
					setBusDisplayName(route?.params?.busDisplayName || normalizedBus);

					unsubscribeFromBus = subscribeToBusLocation(
						normalizedBus,
						(snapshot) => {
							const sessionMarker =
								snapshot?.activeTrackingSession ?? snapshot?.trackingSessionId;
							const trackingActive = Boolean(
								snapshot?.isTracking &&
								(sessionMarker !== undefined ? sessionMarker : snapshot?.isTracking)
							);
							const coords = snapshot?.currentLocation;
							const hasValidCoords = Number.isFinite(coords?.latitude) && Number.isFinite(coords?.longitude);

							if (trackingActive && hasValidCoords) {
								const normalizedSpeed = Number(snapshot?.speed ?? coords?.speed ?? 0);
								const normalizedHeading = Number(snapshot?.heading ?? coords?.heading ?? 0);
								setBusLocation({
									latitude: Number(coords.latitude),
									longitude: Number(coords.longitude),
									speed: Number.isFinite(normalizedSpeed) ? normalizedSpeed : 0,
									heading: Number.isFinite(normalizedHeading) ? normalizedHeading : 0,
									updatedAt: snapshot?.lastUpdate || Date.now(),
								});
								setIsBusTracking(true);
							} else {
								setBusLocation(null);
								setIsBusTracking(false);
							}
						},
						(error) => {
							console.error('Bus subscription error', error);
							setBusLocation(null);
							setIsBusTracking(false);
						}
					);
				}

				if (resolvedRole === 'student') {
					await ensureStudentLocation();
				} else if (route?.params?.studentLocation) {
					setStudentLocation(route.params.studentLocation);
				}
			} catch (error) {
				console.error('Failed to initialise map screen', error);
				Alert.alert('Map Error', 'Unable to load map data. Please try again.');
			} finally {
				setLoading(false);
			}
		};

		initialise();

		return () => {
			if (typeof unsubscribeFromBus === 'function') {
				unsubscribeFromBus();
			}
			setBusLocation(null);
			setIsBusTracking(false);
		};
	}, [route, ensureStudentLocation]);

	const fitRoute = useCallback(() => {
		fitPointsWithCamera(routeOnlyCoordinates);
	}, [routeOnlyCoordinates, fitPointsWithCamera]);

	const focusOnBus = useCallback(() => {
		if (!busLocation || !isBusTracking) {
			return;
		}
		animateToCoordinate(busLocation);
	}, [busLocation, isBusTracking, animateToCoordinate]);

	const focusOnStudent = useCallback(() => {
		if (!studentLocation) {
			return;
		}
		animateToCoordinate(studentLocation);
	}, [studentLocation, animateToCoordinate]);

	const fitEverything = useCallback(() => {
		fitPointsWithCamera(allMapPoints);
	}, [allMapPoints, fitPointsWithCamera]);

	useEffect(() => {
		if (mapReady) {
			fitRoute();
		}
	}, [mapReady, fitRoute]);

	if (loading) {
		return (
			<View style={styles.loaderContainer}>
				<ActivityIndicator size="large" color={COLORS.primary || '#0066CC'} />
				<Text style={styles.loaderLabel}>Preparing live map…</Text>
			</View>
		);
	}

	return (
		<SafeAreaView style={styles.container}>
			<View style={styles.header}>
				<TouchableOpacity style={styles.backButton} onPress={() => navigation?.goBack?.()}>
					<Ionicons name="arrow-back" size={20} color="#1F2937" />
				</TouchableOpacity>
				<View>
					<Text style={styles.title}>Live Route Overview</Text>
					<Text style={styles.subtitle}>
						{busDisplayName ? `Tracking ${busDisplayName}` : 'Select a bus to begin tracking'}
					</Text>
				</View>
			</View>

			<View style={styles.mapContainer}>
				<MapView
					provider={PROVIDER_GOOGLE}
					style={styles.map}
					initialRegion={{
						latitude: initialRegion.latitude,
						longitude: initialRegion.longitude,
						latitudeDelta: 0.0922,
						longitudeDelta: 0.0421,
					}}
					ref={cameraRef}
					onMapReady={() => setMapReady(true)}
					showsUserLocation
					showsMyLocationButton
					zoomEnabled
					scrollEnabled
					pitchEnabled={false}
					rotateEnabled
				>
					{/* Route Polyline */}
					{osrmPolyline.length > 0 && (
						<Polyline
							coordinates={osrmPolyline}
							strokeColor={COLORS.success || '#22C55E'}
							strokeWidth={5}
							geodesic
						/>
					)}

					{/* Route Stops */}
					{routeStops.map((stop) => (
						<Marker
							key={stop.id || stop.name}
							coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
							title={stop.name}
							description={`Stop ${routeStops.indexOf(stop) + 1}`}
						>
							<View style={styles.stopMarker}>
								<View style={styles.stopInnerDot} />
							</View>
						</Marker>
					))}

					{/* Bus Location */}
					{isBusTracking && busLocation && (
						<BusMarker coordinate={busLocation} label={busMarkerLabel} />
					)}

					{/* Student Location */}
					{studentLocation && (
						<Marker
							coordinate={studentLocation}
							title="Your Location"
							description="Current position"
						>
							<View style={[styles.stopMarker, styles.studentMarker]}>
								<View style={styles.stopInnerDot} />
							</View>
						</Marker>
					)}
				</MapView>

				<Animated.View style={[styles.actionButtons, { bottom: actionButtonsBottom }]}>
					<TouchableOpacity style={styles.circleButton} onPress={fitRoute}>
						<Ionicons name="navigate" size={20} color="#FFFFFF" />
					</TouchableOpacity>

					{isBusTracking && busLocation && (
						<TouchableOpacity style={styles.circleButton} onPress={focusOnBus}>
							<Ionicons name="bus" size={20} color="#FFFFFF" />
						</TouchableOpacity>
					)}

					{studentLocation && (
						<TouchableOpacity style={styles.circleButton} onPress={focusOnStudent}>
							<Ionicons name="person" size={20} color="#FFFFFF" />
						</TouchableOpacity>
					)}

					{allMapPoints.length > 0 && (
						<TouchableOpacity style={styles.circleButton} onPress={fitEverything}>
							<Ionicons name="scan" size={20} color="#FFFFFF" />
						</TouchableOpacity>
					)}
				</Animated.View>

				{!!routeWarning && (
					<View style={styles.warningBanner}>
						<Ionicons name="warning" size={16} color="#DC2626" />
						<Text style={styles.warningText}>{routeWarning}</Text>
					</View>
				)}

				{fetchingRoute && (
					<View style={styles.routeLoader}>
						<ActivityIndicator size="small" color="#FFFFFF" />
						<Text style={styles.routeLoaderText}>Fetching OSRM route…</Text>
					</View>
				)}

				<Animated.View
					style={[styles.routeSheet, { height: sheetHeight }]}
					{...panResponder.panHandlers}
				>
					<TouchableOpacity activeOpacity={0.8} onPress={handleSheetToggle}>
						<View style={styles.sheetHandle} />
					</TouchableOpacity>

					<View style={styles.sheetSummaryRow}>
						<View style={styles.sheetSummaryItem}>
							<View style={[styles.sheetIconCircle, { backgroundColor: '#10B981' }]}>
								<Ionicons name="bus" size={20} color="#FFFFFF" />
							</View>
							<View style={styles.sheetSummaryTexts}>
								<Text style={styles.sheetSummaryLabel}>Current Stop</Text>
								<Text style={styles.sheetSummaryTitle} numberOfLines={1}>
									{summaryCurrentName}
								</Text>
								<Text style={[styles.sheetSummaryEta, { color: summaryCurrentEtaColor }]}>
									{summaryCurrentEta}
								</Text>
							</View>
						</View>
						<View style={styles.sheetSeparator} />
						<View style={styles.sheetSummaryItem}>
							<View style={[styles.sheetIconCircle, { backgroundColor: '#2563EB' }]}>
								<Ionicons name="navigate" size={20} color="#FFFFFF" />
							</View>
							<View style={styles.sheetSummaryTexts}>
								<Text style={styles.sheetSummaryLabel}>Next Stop</Text>
								<Text style={styles.sheetSummaryTitle} numberOfLines={1}>
									{summaryNextName}
								</Text>
								<Text style={[styles.sheetSummaryEta, { color: summaryNextEtaColor }]}>
									{summaryNextEta}
								</Text>
							</View>
						</View>
					</View>

					<ScrollView
						style={styles.sheetStopsList}
						contentContainerStyle={styles.sheetStopsContent}
						showsVerticalScrollIndicator={false}
						scrollEnabled={sheetExpanded}
					>
						{routeProgress.stops.map((stop, idx) => {
							const isLast = idx === routeProgress.stops.length - 1;
							const statusColor = STOP_STATUS_COLORS[stop.status] || STOP_STATUS_COLORS.upcoming;
							return (
								<View key={stop.id || `${stop.name}-${idx}`} style={styles.stopRow}>
									<View style={styles.timelineContainer}>
										<View style={[styles.timelineDot, { backgroundColor: statusColor }]} />
										{!isLast && (
											<View
												style={[
													styles.timelineLine,
													{
														backgroundColor:
															stop.status === 'completed' || stop.status === 'current'
																? 'rgba(52,211,153,0.45)'
																: 'rgba(255,255,255,0.15)',
													},
												]}
											/>
										)}
									</View>
									<View style={styles.stopInfo}>
										<Text
											style={[
												styles.stopName,
												stop.status === 'completed' && styles.stopNameCompleted,
												stop.status === 'current' && styles.stopNameCurrent,
												stop.status === 'next' && styles.stopNameNext,
											]}
											numberOfLines={2}
										>
											{stop.name}
										</Text>
										{!!stop.etaLabel && <Text style={styles.stopEta}>{stop.etaLabel}</Text>}
									</View>
									{stop.time ? <Text style={styles.stopTime}>{stop.time}</Text> : null}
								</View>
							);
						})}

						{!routeHasStops && (
							<Text style={styles.sheetEmptyText}>No stops configured for this route.</Text>
						)}
					</ScrollView>
				</Animated.View>
			</View>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#FFFFFF',
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingBottom: 12,
		gap: 12,
	},
	backButton: {
		width: 36,
		height: 36,
		borderRadius: 18,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: '#F3F4F6',
	},
	title: {
		fontSize: 18,
		fontWeight: '600',
		color: '#111827',
	},
	subtitle: {
		marginTop: 2,
		fontSize: 13,
		color: '#6B7280',
	},
	mapContainer: {
		flex: 1,
		position: 'relative',
	},
	map: {
		...StyleSheet.absoluteFillObject,
	},
	stopMarker: {
		width: 18,
		height: 18,
		borderRadius: 9,
		backgroundColor: '#FFFFFF',
		borderWidth: 3,
		borderColor: '#F87171',
		alignItems: 'center',
		justifyContent: 'center',
		shadowColor: '#000',
		shadowOffset: { width: 0, height: 1 },
		shadowOpacity: 0.2,
		shadowRadius: 2,
		elevation: 2,
	},
	stopInnerDot: {
		width: 6,
		height: 6,
		borderRadius: 3,
		backgroundColor: '#B91C1C',
	},
	studentMarker: {
		borderColor: COLORS.secondary || '#2563EB',
	},
	busMarkerGroup: {
		alignItems: 'center',
	},
	busMarkerCircle: {
		width: 56,
		height: 56,
		borderRadius: 28,
		backgroundColor: '#FFC107',
		borderWidth: 3,
		borderColor: '#FF9800',
		alignItems: 'center',
		justifyContent: 'center',
		shadowColor: '#000',
		shadowOffset: { width: 0, height: 2 },
		shadowOpacity: 0.3,
		shadowRadius: 3,
		elevation: 5,
	},
	busMarkerEmoji: {
		fontSize: 28,
	},
	busMarkerLabel: {
		marginTop: 4,
		paddingHorizontal: 10,
		paddingVertical: 5,
		backgroundColor: '#FFC107',
		borderRadius: 6,
		borderWidth: 1,
		borderColor: '#FF9800',
	},
	busMarkerLabelText: {
		color: '#000',
		fontSize: 12,
		fontWeight: '700',
	},
	actionButtons: {
		position: 'absolute',
		right: 16,
		bottom: SHEET_COLLAPSED_HEIGHT + 24,
		gap: 12,
	},
	circleButton: {
		width: 44,
		height: 44,
		borderRadius: 22,
		backgroundColor: COLORS.primary || '#1D4ED8',
		alignItems: 'center',
		justifyContent: 'center',
		shadowColor: '#000',
		shadowOpacity: 0.15,
		shadowOffset: { width: 0, height: 2 },
		shadowRadius: 3,
		elevation: 3,
	},
	warningBanner: {
		position: 'absolute',
		top: 16,
		left: 16,
		right: 16,
		borderRadius: 12,
		backgroundColor: '#FEE2E2',
		paddingVertical: 10,
		paddingHorizontal: 14,
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
	},
	warningText: {
		flex: 1,
		color: '#B91C1C',
		fontSize: 12,
	},
	routeLoader: {
		position: 'absolute',
		alignSelf: 'center',
		bottom: 32,
		backgroundColor: '#111827',
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderRadius: 999,
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
	},
	routeLoaderText: {
		color: '#FFFFFF',
		fontSize: 12,
		fontWeight: '500',
	},
	routeSheet: {
		position: 'absolute',
		left: 16,
		right: 16,
		bottom: 16,
		backgroundColor: '#0F172A',
		borderRadius: 24,
		paddingHorizontal: 20,
		paddingTop: 12,
		paddingBottom: 20,
		overflow: 'hidden',
		shadowColor: '#000',
		shadowOffset: { width: 0, height: 6 },
		shadowOpacity: 0.25,
		shadowRadius: 16,
		elevation: 12,
	},
	sheetHandle: {
		width: 46,
		height: 5,
		borderRadius: 999,
		backgroundColor: 'rgba(255,255,255,0.25)',
		alignSelf: 'center',
		marginBottom: 12,
	},
	sheetSummaryRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
	},
	sheetSummaryItem: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
	},
	sheetIconCircle: {
		width: 44,
		height: 44,
		borderRadius: 22,
		alignItems: 'center',
		justifyContent: 'center',
		marginRight: 12,
	},
	sheetSummaryTexts: {
		flex: 1,
	},
	sheetSummaryLabel: {
		color: 'rgba(248,250,252,0.7)',
		fontSize: 11,
		fontWeight: '600',
		letterSpacing: 0.5,
		textTransform: 'uppercase',
		marginBottom: 2,
	},
	sheetSummaryTitle: {
		color: '#F8FAFC',
		fontSize: 16,
		fontWeight: '700',
	},
	sheetSummaryEta: {
		marginTop: 4,
		color: '#34D399',
		fontSize: 12,
		fontWeight: '500',
	},
	sheetSeparator: {
		width: StyleSheet.hairlineWidth,
		height: 56,
		backgroundColor: 'rgba(255,255,255,0.15)',
		marginHorizontal: 12,
	},
	sheetStopsList: {
		marginTop: 16,
	},
	sheetStopsContent: {
		paddingBottom: 24,
	},
	stopRow: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 12,
		marginBottom: 16,
	},
	timelineContainer: {
		alignItems: 'center',
	},
	timelineDot: {
		width: 12,
		height: 12,
		borderRadius: 6,
	},
	timelineLine: {
		width: 2,
		flex: 1,
		marginTop: 4,
	},
	stopInfo: {
		flex: 1,
	},
	stopName: {
		color: '#E2E8F0',
		fontSize: 14,
		fontWeight: '600',
	},
	stopNameCompleted: {
		color: 'rgba(226,232,240,0.55)',
		textDecorationLine: 'line-through',
	},
	stopNameCurrent: {
		color: '#FBBF24',
	},
	stopNameNext: {
		color: '#38BDF8',
	},
	stopEta: {
		marginTop: 4,
		color: 'rgba(226,232,240,0.75)',
		fontSize: 12,
	},
	stopTime: {
		color: 'rgba(226,232,240,0.6)',
		fontSize: 12,
		fontVariant: ['tabular-nums'],
	},
	sheetEmptyText: {
		color: 'rgba(226,232,240,0.75)',
		textAlign: 'center',
		fontSize: 13,
	},
	loaderContainer: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: '#FFFFFF',
	},
	loaderLabel: {
		marginTop: 12,
		fontSize: 14,
		color: '#4B5563',
	},
});

export default MapScreen;

