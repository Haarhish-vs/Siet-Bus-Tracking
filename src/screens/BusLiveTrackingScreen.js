import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Polyline, Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import * as Location from 'expo-location';
import { COLORS, SAMPLE_STOPS } from '../utils/constants';
import { Ionicons } from '@expo/vector-icons';
import { subscribeToBusLocation } from '../services/locationService';

const toLngLat = (point = {}) => ({ latitude: Number(point.latitude) || 0, longitude: Number(point.longitude) || 0 });
const SIET_CENTER = { latitude: 11.0168, longitude: 76.9558 };

const computeBounds = (points = []) => {
  if (!points.length) {
    return null;
  }
  const lats = points.map((pt) => pt.latitude);
  const lngs = points.map((pt) => pt.longitude);
  return {
    northEast: [Math.max(...lngs), Math.max(...lats)],
    southWest: [Math.min(...lngs), Math.min(...lats)],
  };
};

const BusLiveTrackingScreen = ({ route, navigation }) => {
  const { bus } = route.params; // Get bus details from navigation params
  const [busLocation, setBusLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const cameraRef = useRef(null);
  const rawBusLabel = bus?.displayName || bus?.name || bus?.busName || bus?.number || 'Bus';
  const busDisplayName = typeof rawBusLabel === 'string'
    ? rawBusLabel.replace(/-+/g, '-').trim() || 'Bus'
    : 'Bus';
  const sampleRouteShape = useMemo(() => ({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: SAMPLE_STOPS.map((stop) => [stop.longitude, stop.latitude]),
    },
    properties: {},
  }), []);

  // 🔥 Subscribe to real-time bus location updates from Firestore
  useEffect(() => {
    let unsubscribe = null;
    let timeoutId = null;
    
    console.log('🔥 [ADMIN] Setting up real-time GPS tracking for bus:', bus.number);
    console.log('🔍 [ADMIN] Bus details:', JSON.stringify(bus));
    
    // Set timeout for loading state (5 seconds - same as student)
    timeoutId = setTimeout(() => {
      console.log('⏱️ [ADMIN] Loading timeout - setting loading to false');
      setLoading(false);
    }, 5000);
    
    unsubscribe = subscribeToBusLocation(
      bus.number,
      (locationData) => {
        // Clear timeout since we got data
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        
        console.log('📦 [ADMIN] Raw location data received:', JSON.stringify(locationData));
        
        const isTrackingActive = Boolean(
          locationData?.isTracking &&
            (locationData?.activeTrackingSession ?? locationData?.trackingSessionId ?? locationData?.isTracking)
        );

        if (locationData && locationData.currentLocation && isTrackingActive) {
          console.log('📍 [ADMIN] Location update:', JSON.stringify(locationData.currentLocation));
          console.log('🔥 [ADMIN] Is tracking:', locationData.isTracking);
          console.log('🚀 [ADMIN] Speed:', locationData.speed);
          console.log('👤 [ADMIN] Driver:', locationData.driverName);
          
          const newLocation = {
            latitude: locationData.currentLocation.latitude,
            longitude: locationData.currentLocation.longitude,
            timestamp: locationData.lastUpdate,
            driverName: locationData.driverName || bus.driver || 'Driver',
            isTracking: isTrackingActive,
            speed: locationData.speed,
            accuracy: locationData.accuracy,
            heading: locationData.heading || 0,
          };
          
          setBusLocation(newLocation);
          
          if (isTrackingActive) {
            animateToCoordinate(newLocation);
          }
          
          console.log('✅ [ADMIN] Bus location state updated successfully');
          setLoading(false);
        } else if (locationData && !isTrackingActive) {
          console.log('⚠️ [ADMIN] Bus stopped tracking - clearing map');
          console.log('🛑 [ADMIN] isTracking:', isTrackingActive);
          setBusLocation(null); // Clear location so marker disappears
          setLoading(false);
        } else {
          console.log('⚠️ [ADMIN] Bus not currently tracking or no location data');
          console.log('⚠️ [ADMIN] Full data:', JSON.stringify(locationData));
          setBusLocation(null);
          setLoading(false);
        }
      },
      (error) => {
        console.error('❌ [ADMIN] Tracking error:', error);
        console.error('❌ [ADMIN] Error message:', error.message);
        console.error('❌ [ADMIN] Error stack:', error.stack);
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        setLoading(false);
        // Don't show alert immediately, just log it
      }
    );
    
    console.log('📡 [ADMIN] Subscription setup complete for bus:', bus.number);
    
    // Cleanup subscription on unmount
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (unsubscribe) {
        console.log('🛑 [ADMIN] Unsubscribing from bus location updates');
        unsubscribe();
      }
    };
  }, [bus.number, animateToCoordinate]);

  const animateToCoordinate = useCallback((coordinate) => {
    if (!cameraRef.current || !coordinate) {
      return;
    }
    const center = toLngLat(coordinate);
    cameraRef.current.animateCamera(
      {
        center,
        zoom: 16,
        heading: coordinate.heading || 0,
      },
      { duration: 1000 }
    );
  }, []);

  const fitPoints = useCallback((points = []) => {
    if (!cameraRef.current || !points.length) {
      return;
    }
    cameraRef.current.fitToCoordinates(points, {
      edgePadding: { top: 64, right: 64, bottom: 64, left: 64 },
      animated: true,
    });
  }, []);

  const centerMapOnBus = () => {
    if (busLocation) {
      animateToCoordinate(busLocation);
    } else {
      Alert.alert('No Location', 'Bus location is not available');
    }
  };

  const showFullRoute = () => {
    const locations = busLocation ? [busLocation, ...SAMPLE_STOPS] : SAMPLE_STOPS;
    fitPoints(locations);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={24} color={COLORS.secondary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Live Tracking</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.loadingText}>Loading bus location...</Text>
          <Text style={styles.loadingSubtext}>Bus: {bus.number}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={COLORS.secondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Live Tracking - {bus.number.replace(/-+/g, '-')}</Text>
        <TouchableOpacity onPress={centerMapOnBus} style={styles.centerButton}>
          <Ionicons name="locate" size={24} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      <MapView
        provider={PROVIDER_GOOGLE}
        style={styles.map}
        initialRegion={{
          latitude: busLocation?.latitude || SIET_CENTER.latitude,
          longitude: busLocation?.longitude || SIET_CENTER.longitude,
          latitudeDelta: 0.0922,
          longitudeDelta: 0.0421,
        }}
        ref={cameraRef}
        showsUserLocation
        showsMyLocationButton
        zoomEnabled
        scrollEnabled
        pitchEnabled={false}
        rotateEnabled
      >
        {/* Route Polyline */}
        <Polyline
          coordinates={sampleRouteShape.geometry.coordinates.map(([lng, lat]) => ({
            latitude: lat,
            longitude: lng,
          }))}
          strokeColor={COLORS.accent}
          strokeWidth={3}
          lineDashpattern={[1, 1]}
          geodesic
        />

        {/* Sample Stops */}
        {SAMPLE_STOPS.map((stop, index) => (
          <Marker
            key={`stop-${index}`}
            coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
            title={`Stop ${index + 1}`}
          >
            <View style={styles.stopMarker}>
              <View style={styles.stopInnerDot} />
            </View>
          </Marker>
        ))}

        {/* Bus Location */}
        {busLocation && busLocation.isTracking && (
          <Marker
            coordinate={toLngLat(busLocation)}
            title={busDisplayName}
            description="Current Bus Location"
          >
            <View style={styles.busMarkerGroup}>
              <View style={styles.busMarkerCircle}>
                <Text style={styles.busMarkerEmoji}>🚌</Text>
              </View>
              <View style={styles.busMarkerLabel}>
                <Text style={styles.busMarkerLabelText}>{busDisplayName}</Text>
              </View>
            </View>
          </Marker>
        )}
      </MapView>

      {/* Minimal Status Card - Only show when tracking */}
      {busLocation && busLocation.isTracking && (
        <View style={styles.minimalStatusCard}>
          <View style={styles.liveIndicator}>
            <View style={styles.livePulse} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
          <Text style={styles.minimalSpeed}>
            {(busLocation.speed * 3.6).toFixed(0)} km/h
          </Text>
        </View>
      )}

      {/* Map Control Buttons */}
      <View style={styles.mapControls}>
        <TouchableOpacity 
          style={styles.controlButton} 
          onPress={centerMapOnBus}
          disabled={!busLocation}
        >
          <Ionicons 
            name="locate" 
            size={22} 
            color={busLocation ? COLORS.white : COLORS.gray} 
          />
          <Text style={[styles.controlButtonText, !busLocation && { color: COLORS.gray }]}>
            Center Bus
          </Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={styles.controlButton} 
          onPress={showFullRoute}
        >
          <Ionicons name="map-outline" size={22} color={COLORS.white} />
          <Text style={styles.controlButtonText}>View Route</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    marginTop: 15,
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.secondary,
  },
  loadingSubtext: {
    marginTop: 8,
    fontSize: 14,
    color: COLORS.gray,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 15,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.lightGray,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 4,
  },
  backButton: {
    padding: 5,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.secondary,
    flex: 1,
    textAlign: 'center',
    marginHorizontal: 10,
  },
  centerButton: {
    padding: 5,
  },
  placeholder: {
    width: 34,
  },
  map: {
    ...StyleSheet.absoluteFillObject,
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
  stopMarker: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: COLORS.white,
    borderWidth: 2,
    borderColor: COLORS.secondary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: COLORS.secondary,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 3,
  },
  stopInnerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.secondary,
  },
  minimalStatusCard: {
    position: 'absolute',
    top: 60,
    right: 15,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    borderRadius: 20,
    paddingHorizontal: 15,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  minimalSpeed: {
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.white,
    marginLeft: 10,
  },
  liveIndicator: {
    backgroundColor: COLORS.success,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: COLORS.success,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  livePulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.white,
    marginRight: 6,
  },
  liveText: {
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.lightGray,
    marginVertical: 15,
  },
  infoGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  infoItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  infoLabel: {
    fontSize: 11,
    color: COLORS.gray,
    marginTop: 4,
    fontWeight: '500',
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.secondary,
    marginTop: 2,
  },
  locationInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.lightGray,
  },
  coordinatesText: {
    fontSize: 12,
    color: COLORS.gray,
    marginLeft: 6,
    fontFamily: 'monospace',
  },
  offlineMessage: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 15,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    marginBottom: 10,
  },
  offlineTextContainer: {
    flex: 1,
    marginLeft: 12,
  },
  offlineTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.secondary,
    marginBottom: 8,
  },
  offlineText: {
    fontSize: 14,
    color: COLORS.gray,
    lineHeight: 20,
    marginBottom: 12,
  },
  offlineSteps: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.secondary,
    marginBottom: 6,
  },
  offlineStep: {
    fontSize: 13,
    color: COLORS.gray,
    lineHeight: 22,
    paddingLeft: 8,
  },
  debugInfo: {
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.lightGray,
    alignItems: 'center',
  },
  debugText: {
    fontSize: 11,
    color: COLORS.gray,
    fontFamily: 'monospace',
  },
  mapControls: {
    position: 'absolute',
    bottom: 30,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  controlButton: {
    backgroundColor: COLORS.secondary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 25,
    flex: 1,
    marginHorizontal: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 6,
  },
  controlButtonText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 8,
  },
});

export default BusLiveTrackingScreen;
