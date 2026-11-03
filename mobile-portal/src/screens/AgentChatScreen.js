import React, { useState } from 'react';
import { StyleSheet, Text, View, TextInput, ScrollView, TouchableOpacity } from 'react-native';

// OCULUS MOBILE: AGENT INSTRUCTOR CHAT
// Role: @Gemini-Mobile-Ops-Specialist

export default function AgentChatScreen() {
  const [messages, setMessages] = useState([
    { id: 1, sender: 'Agent', text: 'Oculus Core active. How can I assist with your Phase 2 project today?' }
  ]);
  const [inputText, setInputText] = useState('');

  const sendMessage = async () => {
    if (inputText.trim() === '') return;
    
    const studentMessage = { id: Date.now(), sender: 'Student', text: inputText };
    setMessages(prev => [...prev, studentMessage]);
    setInputText('');

    try {
      const response = await fetch('http://localhost:8080/api/v1/academy/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json.stringify({
          hub_id: 'RESA-001',
          student_id: 'STU-99',
          message: inputText
        })
      });
      const data = await response.json();
      setMessages(prev => [...prev, { 
        id: Date.now() + 1, 
        sender: 'Agent', 
        text: data.response 
      }]);
    } catch (error) {
      setMessages(prev => [...prev, { 
        id: Date.now() + 1, 
        sender: 'Agent', 
        text: 'ERROR: Fleet Connection Offline. Re-routing...' 
      }]);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>ACADEMY INSTRUCTOR CHAT</Text>
      
      <ScrollView style={styles.chatArea}>
        {messages.map(msg => (
          <View key={msg.id} style={[styles.bubble, msg.sender === 'Agent' ? styles.agentBubble : styles.studentBubble]}>
            <Text style={styles.senderLabel}>{msg.sender.toUpperCase()}</Text>
            <Text style={styles.messageText}>{msg.text}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={styles.inputContainer}>
        <TextInput 
          style={styles.input}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Enter command..."
          placeholderTextColor="#444"
        />
        <TouchableOpacity style={styles.sendButton} onPress={sendMessage}>
          <Text style={styles.sendButtonText}>SEND</Text>
        </TouchableOpacity>
      </View>
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
  chatArea: {
    flex: 1,
  },
  bubble: {
    padding: 15,
    marginVertical: 5,
    maxWidth: '85%',
  },
  agentBubble: {
    backgroundColor: '#111820',
    alignSelf: 'flex-start',
    borderLeftWidth: 3,
    borderLeftColor: '#00F2FF',
  },
  studentBubble: {
    backgroundColor: '#1A242D',
    alignSelf: 'flex-end',
    borderRightWidth: 3,
    borderRightColor: '#888',
  },
  senderLabel: {
    color: '#00F2FF',
    fontSize: 8,
    fontFamily: 'Courier',
    marginBottom: 5,
    opacity: 0.7,
  },
  messageText: {
    color: '#fff',
    fontFamily: 'Courier',
    fontSize: 12,
  },
  inputContainer: {
    flexDirection: 'row',
    paddingVertical: 20,
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  input: {
    flex: 1,
    backgroundColor: '#111820',
    color: '#00F2FF',
    fontFamily: 'Courier',
    padding: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  sendButton: {
    backgroundColor: '#00F2FF',
    paddingHorizontal: 20,
    justifyContent: 'center',
    marginLeft: 10,
  },
  sendButtonText: {
    color: '#0A0F14',
    fontFamily: 'Courier',
    fontWeight: 'bold',
  },
});
