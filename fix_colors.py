# C:\Users\dbkr\workspace\daa-public-staging\fix_colors.py
# Status: 🟢 ACTIVE | Sprint: 1011 | Last Revised: 2026-04-02
# Owner: @CTO-Agent | Project: DAA Infinite Synthesis


import os
import re

files_to_update = [
    "students.html",
    "instructors.html",
    "partners.html",
    "subscriptions.html",
    "dashboard.html",
]

replacements = {
    "#0066CC": "var(--daa-primary)",
    "#004A99": "var(--daa-primary-dark, #0052A3)",
    "#66CC00": "var(--daa-accent)",
    "#52A300": "var(--daa-accent-dark, #52A300)",
    "#CC5522": "var(--daa-secondary)",
    "#222": "var(--daa-fg)",
    "#f7f7fa": "var(--daa-bg)",
    "white": "var(--daa-bg-card)",
    "#666": "var(--daa-fg-muted)",
}


def update_file(filepath):
    with open(filepath, "r") as f:
        content = f.read()

    # Replace the body style to use the standard background and color
    content = re.sub(
        r"body\s*{([^}]*)}",
        r"body {\1\n            transition: background 0.3s, color 0.3s;\n        }",
        content,
    )

    style_pattern = re.compile(r"<style>(.*?)</style>", re.DOTALL)
    match = style_pattern.search(content)
    if match:
        style_content = match.group(1)
        for old, new in replacements.items():
            if old.startswith("#"):
                style_content = re.sub(old, new, style_content, flags=re.IGNORECASE)

        style_content = style_content.replace(
            "background: white;", "background: var(--daa-bg-card);"
        )
        style_content = style_content.replace("color: white;", "color: var(--daa-bg);")

        content = content[: match.start(1)] + style_content + content[match.end(1) :]

    with open(filepath, "w") as f:
        f.write(content)


if __name__ == "__main__":
    for f in files_to_update:
        if os.path.exists(f):
            update_file(f)
            print(f"Fixed colors in {f}")
