import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, ScrollView } from 'react-native';

// OCULUS MOBILE: PROJECT TELEMETRY SCREEN
// Role: @Gemini-Mobile-Ops-Specialist

export default function TelemetryScreen() {
  const [robotPos, setRobotPos] = useState({ x: 124.5, y: 88.2, z: 45.0 });
  const [sensorValue, setSensorValue] = useState(42);

  // Simulate real-time data flow from local MCP server
  useEffect(() => {
    const interval = setInterval(() => {
      setRobotPos(prev => ({
        x: (prev.x + (Math.random() - 0.5)).toFixed(1),
        y: (prev.y + (Math.random() - 0.5)).toFixed(1),
        z: (prev.z + (Math.random() - 0.5)).toFixed(1),
      }));
      setSensorValue(Math.floor(Math.random() * 100));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>SYSTEM TELEMETRY</Text>
      
      <ScrollView style={styles.scroll}>
        <View style={styles.metricGroup}>
          <Text style={styles.label}>ROBOT ARM POSITION (XYZ)</Text>
          <View style={styles.coordRow}>
            <View style={styles.coordBox}><Text style={styles.coordText}>X: {robotPos.x}</Text></View>
            <View style={styles.coordBox}><Text style={styles.coordText}>Y: {robotPos.y}</Text></View>
            <View style={styles.coordBox}><Text style={styles.coordText}>Z: {robotPos.z}</Text></View>
          </View>
        </View>

        <View style={styles.metricGroup}>
          <Text style={styles.label}>LIDAR SENSOR ARRAY</Text>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${sensorValue}%` }]} />
          </View>
          <Text style={styles.valueText}>{sensorValue} units | ACTIVE</Text>
        </View>

        <View style={styles.metricGroup}>
          <Text style={styles.label}>AGENT ORCHESTRATION STATUS</Text>
          <Text style={styles.statusText}>[✓] Academy-Instructor: LINKED</Text>
          <Text style={styles.statusText}>[✓] Codebase-Auditor: MONITORING</Text>
          <Text style={styles.statusText}>[○] Client-Onboarding: IDLE</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0F14',
    width: '100%',
    paddingTop: 20,
  },
  sectionTitle: {
    color: '#00F2FF',
    fontSize: 14,
    fontFamily: 'Courier',
    letterSpacing: 3,
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#00F2FF',
    paddingBottom: 5,
  },
  scroll: {
    flex: 1,
  },
  metricGroup: {
    marginBottom: 30,
  },
  label: {
    color: '#888',
    fontSize: 10,
    fontFamily: 'Courier',
    marginBottom: 10,
  },
  coordRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  coordBox: {
    backgroundColor: '#111820',
    borderWidth: 1,
    borderColor: '#333',
    padding: 10,
    width: '30%',
    alignItems: 'center',
  },
  coordText: {
    color: '#00F2FF',
    fontFamily: 'Courier',
    fontSize: 12,
  },
  progressBarBg: {
    height: 10,
    backgroundColor: '#111820',
    width: '100%',
    borderRadius: 5,
    overflow: 'hidden',
    marginBottom: 5,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#00F2FF',
  },
  valueText: {
    color: '#00F2FF',
    fontFamily: 'Courier',
    fontSize: 12,
    textAlign: 'right',
  },
  statusText: {
    color: '#fff',
    fontFamily: 'Courier',
    fontSize: 12,
    marginVertical: 2,
  },
});
