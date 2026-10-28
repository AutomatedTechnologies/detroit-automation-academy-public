## C:\Users\dbkr\workspace\daa-public-staging\GITHUB_PAGES_SETUP.md
## Status: 🟢 ACTIVE | Sprint: 1011 | Last Revised: 2026-04-02
## Owner: @CTO-Agent | Project: DAA Infinite Synthesis


# GitHub Pages Deployment Configuration

**File Location:** C:\Users\dbkr\workspace\daa-public-staging\GITHUB_PAGES_SETUP.md

---

## GitHub Pages Hosting for Detroit Automation Academy

## Current HTTPS Remediation

The repository is configured for the apex domain `detroitautomationacademy.com`, but the live GitHub Pages site must use the same custom domain. In GitHub repository settings, open **Settings -> Pages** and set **Custom domain** to:

```text
detroitautomationacademy.com
```

Save the setting, wait for the certificate status to become ready, then enable **Enforce HTTPS**. The current API state has the custom domain set to `www.detroitautomationacademy.com` and HTTPS enforcement disabled, which causes GitHub's `*.github.io` certificate to be served for the custom domain.

The apex DNS records must remain the four GitHub Pages A records listed below. Do not point the apex at a different hosting provider while GitHub Pages is selected as the deployment target.

The public conversion pages use same-origin `/blog/` and `enroll.html` links. Keep `blog.detroitautomationacademy.com`, `enroll.detroitautomationacademy.com`, and `checkout.detroitautomationacademy.com` out of public links until DNS records and certificates are provisioned for those hosts.

**Status:** Ready to configure  
**Date:** March 31, 2026  
**Target Launch:** April 2, 2026

---

## DNS Configuration for GitHub Pages

### Apex Domain Setup

**Domain:** `detroitautomationacademy.com`

Point your apex domain using **A records** to the following GitHub Pages IP addresses:

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

Or using **AAAA records** for IPv6:

```
2606:50c0:8000::153
2606:50c0:8001::153
2606:50c0:8002::153
2606:50c0:8003::153
```

### Subdomain Setup

**For www subdomain:**
- Create **CNAME record:** `www` → `smit4786.github.io`

**For blog subdomain:**
- Create **CNAME record:** `blog` → `smit4786.github.io`

**For enroll subdomain:**
- Create **CNAME record:** `enroll` → `smit4786.github.io`

---

## DNS Records Summary

| Record | Type | Name | Value |
|--------|------|------|-------|
| Apex (IPv4) | A | @ | 185.199.108.153 |
| Apex (IPv4) | A | @ | 185.199.109.153 |
| Apex (IPv4) | A | @ | 185.199.110.153 |
| Apex (IPv4) | A | @ | 185.199.111.153 |
| Apex (IPv6) | AAAA | @ | 2606:50c0:8000::153 |
| Apex (IPv6) | AAAA | @ | 2606:50c0:8001::153 |
| Apex (IPv6) | AAAA | @ | 2606:50c0:8002::153 |
| Apex (IPv6) | AAAA | @ | 2606:50c0:8003::153 |
| WWW | CNAME | www | smit4786.github.io |
| Blog | CNAME | blog | smit4786.github.io |
| Enroll | CNAME | enroll | smit4786.github.io |

---

## GitHub Pages Custom Domain Configuration

### In GitHub Repository Settings

1. Go to **Settings** → **Pages**
2. Under "Build and deployment":
   - Source: **Deploy from a branch**
   - Branch: **main** (or your deployment branch)
   - Folder: **/** (root) or **/docs** (if files in docs folder)

3. Under "Custom domain":
   - Enter: `detroitautomationacademy.com`
   - Click **Save**
   - GitHub will create a `CNAME` file in repository root

4. Under "Enforce HTTPS":
   - ☑️ **Check this box** (enforce HTTPS)
   - Wait for SSL certificate to be provisioned (~30 minutes)

### Repository Structure for GitHub Pages

```
detroit-automation-academy-public/
├── index.html                          # Landing page
├── enroll.html                         # Enrollment form
├── admin-dashboard.html                # Admin dashboard
├── CNAME                               # GitHub Pages custom domain
├── branding/
│   └── palette.css                     # Design system
├── blog/                               # Blog directory (Hugo output)
│   ├── index.html
│   ├── posts/
│   └── ...
├── scripts/
│   └── deploy.sh
└── docs/                               # Documentation
    ├── BRAND_GUIDELINES.md
    ├── GCP_INFRASTRUCTURE.md           # (Archived, no longer used)
    ├── PRODUCTION_DEPLOYMENT.md
    └── ... (other guides)
```

---

## Deployment Steps for GitHub Pages

### Step 1: Prepare Repository

```bash
# Navigate to repository
cd C:\Users\dbkr\workspace\daa-public-staging

# Ensure all changes are committed
git status

# If files modified:
git add .
git commit -m "Update for GitHub Pages deployment"
git push origin main
```

### Step 2: Configure GitHub Pages in Settings

1. Go to GitHub repository: https://github.com/smit4786/detroit-automation-academy-public
2. Click **Settings** (top right)
3. Select **Pages** (left sidebar)
4. Under "Build and deployment":
   - Select **Deploy from a branch**
   - Branch: **main**
   - Folder: **/**
5. Under "Custom domain":
   - Enter: `detroitautomationacademy.com`
   - Click **Save**
6. GitHub will create `CNAME` file automatically

### Step 3: Update DNS Records

**In your domain registrar's DNS settings:**

**Add A records (IPv4):**
```
Host: @
Type: A
Value: 185.199.108.153

Host: @
Type: A
Value: 185.199.109.153

Host: @
Type: A
Value: 185.199.110.153

Host: @
Type: A
Value: 185.199.111.153
```

**Add AAAA records (IPv6):**
```
Host: @
Type: AAAA
Value: 2606:50c0:8000::153

Host: @
Type: AAAA
Value: 2606:50c0:8001::153

Host: @
Type: AAAA
Value: 2606:50c0:8002::153

Host: @
Type: AAAA
Value: 2606:50c0:8003::153
```

**Add CNAME records (subdomains):**
```
Host: www
Type: CNAME
Value: smit4786.github.io

Host: blog
Type: CNAME
Value: smit4786.github.io

Host: enroll
Type: CNAME
Value: smit4786.github.io
```

### Step 4: Verify DNS Configuration

After 5-10 minutes, run:

```bash
# Check DNS propagation
nslookup detroitautomationacademy.com

# Expected: Should resolve to GitHub Pages IP (185.199.108.x or similar)
```

### Step 5: Enable HTTPS

1. In GitHub Pages settings, wait 10-30 minutes for DNS to propagate
2. Check the **"Enforce HTTPS"** checkbox
3. GitHub will automatically provision SSL certificate (Let's Encrypt)
4. Wait another 5-10 minutes for certificate provisioning

---

## File Structure in Repository

### Root Level (GitHub Pages serves these directly)

```
/
├── index.html                    ← Landing page
├── enroll.html                   ← Enrollment form  
├── admin-dashboard.html          ← Admin dashboard
├── CNAME                         ← GitHub Pages custom domain
├── .gitignore
├── README.md
└── ...
```

### CSS & Design System

```
/branding/
├── palette.css                   ← Design system CSS
└── ...
```

### Blog Content

```
/blog/                            ← Hugo-generated static site
├── index.html
├── posts/
│   ├── epoch-vii-agentic-orchestration/
│   ├── specialized-agent-architecture/
│   ├── michigan-central-infrastructure-deep-dive/
│   └── ecosystem-synergy-epoch-vii/
└── ...
```

### Documentation (Optional - kept in repo for reference)

```
/docs/                            ← Documentation
├── BRAND_GUIDELINES.md
├── DEPLOYMENT_CHECKLIST.md
├── PRODUCTION_DEPLOYMENT.md
├── SEO_ANALYTICS_SETUP.md
└── ...
```

---

## URL Routing with GitHub Pages

### Domain Mapping

| URL | Maps To | Content |
|-----|---------|---------|
| detroitautomationacademy.com | /index.html | Landing page |
| detroitautomationacademy.com/enroll | /enroll.html | Enrollment form |
| detroitautomationacademy.com/admin | /admin-dashboard.html | Admin dashboard |
| blog.detroitautomationacademy.com | /blog/index.html | Blog homepage |
| blog.detroitautomationacademy.com/posts/... | /blog/posts/... | Blog posts |
| enroll.detroitautomationacademy.com | /enroll.html | Enrollment form |

### Direct URL Access

```
Landing: https://detroitautomationacademy.com
Blog: https://detroitautomationacademy.com/blog
Enrollment: https://detroitautomationacademy.com/enroll
Admin: https://detroitautomationacademy.com/admin-dashboard
```

---

## Timeline for GitHub Pages Launch

**March 31, 2026 (Today):**
- [x] Prepare repository structure
- [x] Commit all files
- [x] Push to main branch

**April 1, 2026 (Staging):**
- [ ] Update DNS records (A, AAAA, CNAME)
- [ ] Configure GitHub Pages in repository settings
- [ ] Wait for DNS propagation (~5-10 minutes)
- [ ] Verify site is accessible at custom domain
- [ ] Enable HTTPS and wait for certificate (~20 minutes)
- [ ] Test all pages (landing, blog, enrollment, admin)
- [ ] Verify analytics tracking
- [ ] Monitor for 24 hours

**April 2, 2026 (Go-Live):**
- [ ] Final verification that all systems working
- [ ] DNS fully propagated globally
- [ ] HTTPS certificate active
- [ ] Analytics tracking confirmed
- [ ] Announce launch to public

---

## Benefits of GitHub Pages

✅ **Free hosting** - No GCP costs  
✅ **Automatic HTTPS** - Let's Encrypt certificates (free)  
✅ **Fast CDN** - GitHub's CDN serves content globally  
✅ **Simple deployment** - Push to GitHub = automatic deployment  
✅ **Version control** - All changes tracked in git  
✅ **Integrated CI/CD** - GitHub Actions for automated builds  
✅ **Custom domains** - Support for apex and subdomains  
✅ **Scalable** - Handles unlimited traffic  

---

## Limitations to Note

⚠️ **Static content only** - No server-side processing  
⚠️ **Form handling** - Must use Netlify Forms or external service  
⚠️ **Dynamic features** - No database or backend (use Firebase, Netlify, etc.)  
⚠️ **File size limit** - 25GB total per repository  
⚠️ **Rate limits** - 10 builds per hour, 100 builds per day  

---

## Comparison: GCP vs GitHub Pages

| Aspect | GCP Cloud Run | GitHub Pages |
|--------|---------------|--------------|
| **Cost** | ~$100-500/month | Free |
| **Setup** | Complex | Simple |
| **Deployment** | Script-based | Git push |
| **HTTPS** | Google-managed | Let's Encrypt |
| **CDN** | Cloud CDN | GitHub CDN |
| **Dynamic content** | Yes | No (static only) |
| **Database** | Cloud SQL, Firestore | External service |
| **Scalability** | Auto-scaling | Built-in |
| **Monitoring** | Cloud Logging | GitHub Actions |

**For EPOCH VII:** GitHub Pages is ideal (static site, no backend needed)

---

## Form Submission Handling with GitHub Pages

**For enrollment form:** Use one of these services

**Option 1: Netlify Forms (Recommended)**
```html
<form name="enrollment" method="POST" netlify>
  <!-- form fields -->
</form>
```

**Option 2: Formspree.io**
```html
<form action="https://formspree.io/f/YOUR_FORM_ID" method="POST">
  <!-- form fields -->
</form>
```

**Option 3: Basin.io**
```html
<form action="https://basin.io/f/YOUR_FORM_ID" method="POST">
  <!-- form fields -->
</form>
```

**Current Setup:** enroll.html already configured with Netlify Forms ✅

---

## Monitoring & Analytics with GitHub Pages

**Google Analytics:** Already configured in all pages  
**Form Submissions:** Via Netlify dashboard  
**Site Traffic:** Google Analytics dashboard  
**Errors:** GitHub Actions logs + browser console  
**Performance:** Google PageSpeed Insights  

---

## Rollback Plan

If issues occur after switching to GitHub Pages:

```bash
# Rollback DNS to previous host (GCP)
# 1. Update A records back to GCP Load Balancer IP
# 2. OR revert to previous DNS configuration
# 3. Changes take effect in 5-30 minutes (depending on TTL)
```

**DNS TTL set to:** 300 seconds (5 minutes)  
**Time to rollback:** < 10 minutes total

---

## Next Steps

1. **Commit repository** (already done ✓)
2. **Update DNS records** (April 1, AM)
3. **Configure GitHub Pages** (April 1, AM)
4. **Verify HTTPS** (April 1, 10:00 AM)
5. **Test all pages** (April 1, 10:30 AM)
6. **Monitor for 24 hours** (April 1-2)
7. **Go-live announcement** (April 2, 9:00 AM)

---

**Co-authored-by:** Copilot <223556219+Copilot@users.noreply.github.com>
