## C:\Users\dbkr\workspace\daa-public-staging\specs\ACADEMY_INSTRUCTOR_API_SPEC.md
## Status: 🟢 ACTIVE | Sprint: 1011 | Last Revised: 2026-04-02
## Owner: @CTO-Agent | Project: DAA Infinite Synthesis


﻿## C:\Users\dbkr\workspace\daa-public-staging\specs\ACADEMY_INSTRUCTOR_API_SPEC.md
# API Specification: Academy-Instructor Remote Orchestration
**Owner:** @CTO
**Status:** DRAFT - Sprint 2 Scaffolding
**Endpoint Base:** `https://api.oculus.core/v1/academy`

## 1. Objective
To provide regional AaaS hubs with secure, tokenized access to the "Academy-Instructor" agent logic. This API enables remote hardware validation, student code auditing, and curriculum-aware chatbot interactions.

## 2. Authentication
- **Method:** Bearer Token (JWT)
- **Scope:** `hub:execution`, `hub:telemetry:read`
- **Identity:** Synchronized with `dim_aaas_hubs` via Google OAuth 2.0.

## 3. Endpoints (MVP)

### 3.1. POST `/validate-hardware`
Validates regional student hardware status via the local MCP bridge.
- **Payload:** `{ "hub_id": "RESA-001", "node_id": "ESP32-X45", "telemetry": { "xyz": [...] } }`
- **Response:** `{ "status": "CALIBRATED", "advice": null }`

### 3.2. POST `/agent/chat`
Proxies student queries to the Academy-Instructor agent instance.
- **Payload:** `{ "district_id": "DPS-042", "student_id": "STU-99", "message": "..." }`
- **Response:** `{ "agent_id": "academy-instructor", "response": "..." }`

### 3.3. GET `/telemetry/pulse`
Aggregated heartbeat of all constituent lab nodes within a regional hub.
- **Response:** `{ "active_nodes": 124, "system_health": "OPTIMIZED" }`

## 4. Error Handling
- `401 Unauthorized`: Invalid or expired Hub Token.
- `403 Forbidden`: Tenant ID mismatch or tier-level restriction.
- `429 Too Many Requests`: Rate limit exceeded (Default: 100 req/min per Hub).
