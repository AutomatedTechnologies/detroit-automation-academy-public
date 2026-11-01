## C:\Users\dbkr\workspace\daa-public-staging\docs\PRD.md
## Status: 🟢 ACTIVE | Sprint: 1011 | Last Revised: 2026-04-02
## Owner: @CTO-Agent | Project: DAA Infinite Synthesis


﻿## C:\Users\dbkr\workspace\daa-public-staging\docs\PRD.md
# Product Requirements Document (PRD): Detroit Automation Academy (DAA)

## 1. Overview
The Detroit Automation Academy (DAA) is a STEM education initiative focused on providing hands-on automation and technology training to youth in Detroit, particularly through partnerships with organizations like the Boys & Girls Clubs of Greater Detroit (Michigan Central Club).

## 2. Mission & Goals
- **Mission:** Empower Detroit youth with future-ready STEM skills through automation and technology education.
- **Goals:**
  - Execute high-impact STEM sessions for cohorts of 50+ participants.
  - Establish a robust infrastructure for curriculum delivery and student tracking.
  - Launch a functional CRM for managing enrollments and stakeholder engagement.
  - Maintain a high-quality public presence via the DAA website.

## 3. Target Audience
- **Primary:** Detroit youth (BGC members).
- **Secondary:** Parents, educators, community partners (Michigan Central, BGC), and potential sponsors.

## 4. Functional Requirements
- **Curriculum Delivery:** Modular STEM sessions (e.g., Robotics, Coding, Automation).
- **Registration System:** Integrated React-based registration portal with real-time Firestore sync.
- **CRM Integration:** Multi-tenant CRM for managing enrollments across different academies (DAA Core, BGC Metro).
- **Admin Dashboard:** Secure, authenticated dashboard for staff to view, manage, and delete enrollment records.
- **Detailed Applicant View:** "Full Records" view displaying comprehensive applicant data (Goals, Experience, Education, etc.).
- **Data Portability:** Export functionality for both summary and full enrollment data to CSV format.
- **Public Website:** Informational site with a multi-language blog (English, German, Russian) for project updates and community engagement.
- **Enterprise SEO:** Advanced SEO metadata and social graph integration across all public pages.
- **Campaign Tracking:** Standardized UTM tracking for all external enrollment links.

## 5. Technical Requirements
- **Website Framework:** HTML/CSS/JS with a tile-based responsive dashboard.
- **Blog Engine:** Hugo with multi-language support (i18n).
- **Branding:** ATSI (Focused Styling Initiative) compliant design.
- **CRM Frontend:** React with TypeScript for enrollment and progress management dashboards.
- **CRM Backend:** Golang-based microservices for data processing and API integration.
- **Hosting/Deployment:**
    - **GitHub Pages:** Static site hosting for the public blog and main website.
    - **GCP:** Cloud Run for CRM backend and frontend; Firestore for student data.
- **Data Layer:** Firestore for real-time student and enrollment data.
- **Authentication:** Google OAuth 2.0 (SSO) for administrative access.
- **Build Tools:** Node.js, npm, and gcloud CLI for automated deployments.
- **Repository:** `detroit-automation-academy-public`.

## 6. Roadmap & Milestones (2026)
- **Feb 4:** BGC Event (50 participants, 5 STEM sessions) - âœ… COMPLETE.
- **Feb 28:** CRM Go-Live (Infrastructure & Multi-tenant support) - âœ… COMPLETE.
- **Mar 2:** CRM Enhancement (Detailed Applicant View & CSV Export) - âœ… COMPLETE.
- **Mar 2:** UI/UX Revitalization (ATSI Branding, Global Nav, Light/Dark Modes) - âœ… COMPLETE.
- **Mar 3:** CMO Activation & Digital Optimization (SEO, UTM, Multi-language) - âœ… COMPLETE.
- **Mar 15:** CRM Phase 2 (Attendance tracking & Instructor portal).


## 7. Agent Coordination & Roles
- **@CTO:** Oversees technical architecture, GitHub Pages deployment, and backend maintenance.
- **@CMO:** Responsible for ecosystem growth, brand parity, and data-driven marketing strategies.
- **@WebsiteAdminAgent:** Responsible for maintaining the standard ATSI theme, CSS variables, and frontend deployments across `detroitautomationacademy.com` and `enroll.detroitautomationacademy.com`. Reports to @CTO.
- **@SocialMediaAgent:** Manages multi-language blog distributions, social media engagement, and campaign tracking.
- **@COO:** Manages project timelines, daily operations, and coordination between DAA and @AutomatedTechnologies.
- **@ADMIN:** Handles registration coordination, communication templates, and administrative support.
- **@Documentation-Auditor:** Ensures all project documentation meets quality standards.

## 8. Constraints & Risks
- **Privacy:** Adherence to strict privacy constraints within the Justin Smith ecosystem.
- **Logistics:** Coordination with external partners (BGC) requires timely communication and approval.
- **Build Integrity:** Strict adherence to Hugo/GitHub Pages deployment rules (e.g., PostCSS location, `.nojekyll`).
