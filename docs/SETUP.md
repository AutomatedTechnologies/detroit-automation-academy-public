## C:\Users\dbkr\workspace\daa-public-staging\docs\SETUP.md
## Status: 🟢 ACTIVE | Sprint: 1011 | Last Revised: 2026-04-02
## Owner: @CTO-Agent | Project: DAA Infinite Synthesis


﻿## C:\Users\dbkr\workspace\daa-public-staging\docs\SETUP.md
# Setup Guide - AT-Infrastructure

Quick start guide for developers using AT-Infrastructure template.

---

## ðŸ“¦ **Prerequisites**

- Python 3.8 or higher
- Git
- pip package manager
- Virtual environment tool (venv)

---

## ðŸš€ **Quick Start (5 minutes)**

### **1. Clone the Repository**

```bash
git clone https://github.com/AutomatedTechnologies/your-project.git
cd your-project
```

### **2. Create Virtual Environment**

```bash
python -m venv venv

# Activate virtual environment
# On macOS/Linux:
source venv/bin/activate

# On Windows:
venv\Scripts\activate
```

### **3. Install Dependencies**

```bash
pip install --upgrade pip
pip install -r requirements.txt
pip install pre-commit
```

### **4. Setup Pre-Commit Hooks**

```bash
pre-commit install
```

### **5. Run Tests**

```bash
pytest -v
```

### **6. Make Your First Commit**

```bash
git add .
git commit -m "init: project setup"
git push origin main
```

---

## ðŸ“ **Development Workflow**

### **Creating a Feature Branch**

```bash
git checkout -b feature/my-feature-name
```

### **Making Changes**

1. Edit files as needed
2. Pre-commit hooks run automatically on `git commit`
3. Fix any formatting issues (Black, Flake8, isort)
4. Commit changes:

```bash
git add .
git commit -m "feat: description of feature"
```

### **Running Tests**

```bash
# Run all tests
pytest -v

# Run specific test file
pytest tests/test_specific.py -v

# Run with coverage
pytest --cov --cov-report=html
```

### **Pushing Changes**

```bash
git push origin feature/my-feature-name
```

### **Creating a Pull Request**

1. Go to GitHub repository
2. Click "New Pull Request"
3. Select your branch
4. Add description
5. Request review
6. CI/CD pipeline runs automatically

---

## ðŸ”§ **Configuration Files**

### **pyproject.toml**
Project configuration, dependencies, tool settings.

Edit this to:
- Add/remove dependencies
- Change Python version requirements
- Customize tool behavior

### **requirements.txt**
Package dependencies list.

Update with:
```bash
pip freeze > requirements.txt
```

### **pre-commit-config.yaml**
Pre-commit hook configuration.

Default hooks:
- Black (code formatting)
- Flake8 (linting)
- isort (import sorting)
- pydocstyle (docstring checking)
- YAML/JSON/TOML validation

### **.pre-commit-config.yaml**
Disable a hook temporarily:

```yaml
- id: black
  stages: [manual]  # Only runs with --hook-stage manual
```

---

## ðŸ› **Troubleshooting**

### **Pre-commit hook failing**

```bash
# See what changed
pre-commit run --all-files

# Fix automatically (Black, isort)
black .
isort .

# Fix manually (Flake8)
flake8 .  # See errors
# Edit files to fix linting issues
```

### **Tests failing**

```bash
# See detailed error
pytest -v --tb=long

# Run specific test
pytest tests/test_file.py::test_function -v
```

### **Virtual environment issues**

```bash
# Remove and recreate venv
rm -rf venv
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### **Git conflicts**

```bash
# See conflicts
git status

# Edit conflicted files manually
# Mark as resolved
git add .
git commit -m "resolve: merge conflicts"
```

---

## ðŸ“Š **Code Quality Standards**

| Tool | Standard | Fix |
|------|----------|-----|
| Black | 88 char lines | `black .` |
| Flake8 | PEP 8 + extras | Manual edit |
| isort | Import order | `isort .` |
| Bandit | Security | Manual review |

---

## ðŸ” **Security Best Practices**

1. **Never commit secrets**
   - API keys, passwords, tokens
   - Use `.gitignore` to exclude them

2. **Scan before committing**
   - Bandit runs in pre-commit
   - Review security warnings

3. **Keep dependencies updated**
   ```bash
   pip list --outdated
   pip install --upgrade package-name
   ```

4. **Review code before pushing**
   ```bash
   git diff origin/main
   ```

---

## ðŸ“š **Additional Resources**

- [Python Virtual Environments](https://docs.python.org/3/tutorial/venv.html)
- [Git Documentation](https://git-scm.com/doc)
- [Pytest Documentation](https://docs.pytest.org/)
- [Pre-commit Documentation](https://pre-commit.com/)

---

**Last Updated:** January 27, 2026
