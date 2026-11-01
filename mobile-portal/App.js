import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, StatusBar } from 'react-native';
import TelemetryScreen from './src/screens/TelemetryScreen';
import AgentChatScreen from './src/screens/AgentChatScreen';

// OCULUS MOBILE PORTAL: CORE ENTRY POINT
// Role: @Gemini-Mobile-Ops-Specialist

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState('Dashboard');

  const renderContent = () => {
    switch(activeTab) {
      case 'Dashboard':
        return (
          <View style={styles.dashboard}>
            <Text style={styles.label}>[SYSTEM ACTIVE]</Text>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>FLEET STATUS</Text>
              <Text style={styles.cardValue}>66 Specialized Units</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>PROPOSAL VELOCITY</Text>
              <Text style={styles.cardValue}>6 ACTIVE DRAFTS</Text>
            </View>
            <View style={styles.navRow}>
              <TouchableOpacity 
                style={styles.navButton}
                onPress={() => setActiveTab('Telemetry')}
              >
                <Text style={styles.buttonText}>TELEMETRY</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.navButton}
                onPress={() => setActiveTab('Chat')}
              >
                <Text style={styles.buttonText}>AGENT CHAT</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      case 'Telemetry':
        return (
          <View style={{ flex: 1, width: '100%' }}>
            <TelemetryScreen />
            <TouchableOpacity 
              style={[styles.button, { marginTop: 20 }]}
              onPress={() => setActiveTab('Dashboard')}
            >
              <Text style={styles.buttonText}>BACK TO DASHBOARD</Text>
            </TouchableOpacity>
          </View>
        );
      case 'Chat':
        return (
          <View style={{ flex: 1, width: '100%' }}>
            <AgentChatScreen />
            <TouchableOpacity 
              style={[styles.button, { marginTop: 20 }]}
              onPress={() => setActiveTab('Dashboard')}
            >
              <Text style={styles.buttonText}>BACK TO DASHBOARD</Text>
            </TouchableOpacity>
          </View>
        );
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>OCULUS CORE</Text>
        <Text style={styles.subtitle}>AAAS TIER 3 PORTAL</Text>
      </View>

      {!isAuthenticated ? (
        <View style={styles.loginContainer}>
          <Text style={styles.label}>[SYSTEM LOCKED]</Text>
          <TouchableOpacity 
            style={styles.button}
            onPress={() => setIsAuthenticated(true)}
          >
            <Text style={styles.buttonText}>AUTHENTICATE BIOMETRIC</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.content}>
          {renderContent()}
        </View>
      )}

      <View style={styles.footer}>
        <Text style={styles.footerText}>AUTOMATED TECHNOLOGIES | PHASE 4</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0F14',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  header: {
    position: 'absolute',
    top: 60,
    alignItems: 'center',
  },
  title: {
    color: '#00F2FF',
    fontSize: 32,
    fontFamily: 'Courier',
    fontWeight: 'bold',
    letterSpacing: 10,
  },
  subtitle: {
    color: '#00F2FF',
    fontSize: 12,
    fontFamily: 'Courier',
    opacity: 0.6,
    marginTop: 5,
  },
  loginContainer: {
    alignItems: 'center',
  },
  content: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    marginTop: 120,
    marginBottom: 80,
  },
  label: {
    color: '#888',
    fontFamily: 'Courier',
    marginBottom: 20,
  },
  button: {
    borderWidth: 2,
    borderColor: '#00F2FF',
    paddingVertical: 15,
    paddingHorizontal: 30,
    alignItems: 'center',
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 20,
  },
  navButton: {
    borderWidth: 1,
    borderColor: '#00F2FF',
    paddingVertical: 10,
    width: '48%',
    alignItems: 'center',
  },
  buttonText: {
    color: '#00F2FF',
    fontFamily: 'Courier',
    fontWeight: 'bold',
    fontSize: 12,
  },
  dashboard: {
    width: '100%',
    alignItems: 'center',
  },
  card: {
    backgroundColor: '#111820',
    borderLeftWidth: 4,
    borderLeftColor: '#00F2FF',
    width: '100%',
    padding: 20,
    marginVertical: 10,
  },
  cardTitle: {
    color: '#888',
    fontSize: 10,
    fontFamily: 'Courier',
  },
  cardValue: {
    color: '#fff',
    fontSize: 18,
    fontFamily: 'Courier',
    marginTop: 5,
  },
  footer: {
    position: 'absolute',
    bottom: 40,
  },
  footerText: {
    color: '#333',
    fontSize: 10,
    fontFamily: 'Courier',
  },
});
