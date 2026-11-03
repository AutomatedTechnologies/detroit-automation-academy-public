## C:\Users\dbkr\workspace\daa-public-staging\update_html.py
## Status: 🟢 ACTIVE | Sprint: 1011 | Last Revised: 2026-04-02
## Owner: @CTO-Agent | Project: DAA Infinite Synthesis

import os
import re
import datetime

# --- CONFIGURATION (EPOCH VII) ---
VERSION = datetime.datetime.now().strftime("%Y%m%d%H")
SEO_DESC = "Detroit Automation Academy: Master autonomous systems, robotics, and CAD design in Detroit. Join Epoch VII to transform into a specialized agent."

# Branding Variables
CYBER_CYAN = "#00f0ff"
CYBER_GREEN = "#39ff14"
STUDENT_PURPLE = "#BB6EE7"
DEEP_CHARCOAL = "#050507"

HEADER_CONTENT = f"""    <header>
        <nav>
            <div class="logo">
                <a href="index.html?v={VERSION}">
                    <svg class="logo-reactive" viewBox="0 0 1000 250" width="180" height="45" xmlns="http://www.w3.org/2000/svg">
                        <g transform="translate(25, 25)">
                            <g id="gear">
                                <circle cx="100" cy="100" r="75" fill="none" stroke="{CYBER_CYAN}" stroke-width="4" />
                                <polygon points="100,30 130,40 140,70 130,100 140,130 100,170 70,160 60,130 70,100 60,70 100,30" fill="none" stroke="{CYBER_CYAN}" stroke-width="3" stroke-linejoin="round" />
                            </g>
                            <g id="circuits" stroke="{CYBER_CYAN}" stroke-width="3" fill="none" stroke-linecap="round">
                                <path d="M 100 30 L 100 15 L 85 10" />
                                <path d="M 130 70 L 155 50 L 170 55" />
                                <path d="M 140 130 L 160 155 L 165 170" />
                                <path d="M 60 160 L 30 180 L 20 175" />
                                <path d="M 60 70 L 35 50 L 25 60" />
                            </g>
                        </g>
                        <g transform="translate(260, 110)">
                            <text font-family="'Courier New', Courier, monospace" font-weight="800" font-size="64">
                                <tspan x="0" y="0" fill="#f8fafc">DETROIT</tspan>
                                <tspan x="0" y="75" font-size="54" font-weight="700" fill="{CYBER_CYAN}">AUTOMATION ACADEMY</tspan>
                            </text>
                        </g>
                    </svg>
                </a>
            </div>
            <ul class="nav-links">
                <li><a href="index.html?v={VERSION}">🏠 Home</a></li>
                <li><a href="https://blog.detroitautomationacademy.com">📝 Blog</a></li>
                <li><a href="dashboard.html?v={VERSION}">📊 Dashboard</a></li>
                <li><a href="students.html?v={VERSION}">👨‍🎓 Students</a></li>
                <li><a href="instructors.html?v={VERSION}">👨‍🏫 Instructors</a></li>
                <li><a href="partners.html?v={VERSION}">💼 Partners</a></li>
                <li><a href="https://enroll.detroitautomationacademy.com" style="color: {CYBER_GREEN}; font-weight: 800; border: 1px solid {CYBER_GREEN}; padding: 5px 12px; border-radius: 6px;">Enroll</a></li>
            </ul>
        </nav>
    </header>"""

FOOTER_CONTENT = f"""    <footer>
        <div class="footer-links">
            <a href="https://blog.detroitautomationacademy.com">Blog</a>
            <a href="dashboard.html?v={VERSION}">Dashboard</a>
            <a href="https://status.detroitautomationacademy.com">System Status</a>
            <a href="https://github.com/smit4786/detroit-automation-academy-public" target="_blank">GitHub</a>
            <a href="mailto:info@detroitautomationacademy.com">Contact</a>
        </div>
        <p>© 2026 Detroit Automation Academy. All rights reserved. |
           Automation skills for Detroit's future, built by Detroiters.</p>
    </footer>"""

FILES_TO_UPDATE = [
    "index.html",
    "students.html",
    "instructors.html",
    "partners.html",
    "subscriptions.html",
    "dashboard.html",
    "admin.html",
    "landing.html",
    "enroll.html",
]


def update_file(filepath):
    if not os.path.exists(filepath):
        print(f"Skipping {filepath} (Not Found)")
        return

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Update Header/Nav
    header_pattern = re.compile(r"<header>.*?</header>", re.DOTALL)
    if header_pattern.search(content):
        content = header_pattern.sub(HEADER_CONTENT, content)

    # 2. Update Footer
    footer_pattern = re.compile(r"<footer>.*?</footer>", re.DOTALL)
    if footer_pattern.search(content):
        content = footer_pattern.sub(FOOTER_CONTENT, content)

    # 3. Inject/Update SEO Meta
    meta_desc_pattern = re.compile(
        r'<meta name="description" content=".*?">', re.DOTALL
    )
    new_meta = f'<meta name="description" content="{SEO_DESC}">'
    if meta_desc_pattern.search(content):
        content = meta_desc_pattern.sub(new_meta, content)

    # 4. Inject Student Purple Accent where appropriate
    if "enroll.html" in filepath or "students.html" in filepath:
        # Example: Update a specific class or button color
        content = content.replace("var(--daa-accent)", "var(--daa-student)")
        content = content.replace("var(--daa-primary)", "var(--daa-student)")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Standardized & Upgraded {filepath} to EPOCH VII")


if __name__ == "__main__":
    for f in FILES_TO_UPDATE:
        update_file(f)
