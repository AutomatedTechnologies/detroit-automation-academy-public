# C:\Users\dbkr\workspace\daa-public-staging\scripts\deploy.sh
# Status: 🟢 ACTIVE | Sprint: 1011 | Last Revised: 2026-04-02
# Owner: @CTO-Agent | Project: DAA Infinite Synthesis


#!/bin/bash

# File Location: scripts/deploy.sh
# Purpose: Automated deployment script for DAA EPOCH VII redesign
# Created: March 31, 2026
# Usage: ./deploy.sh [staging|production] [landing|blog|enrollment|all]

set -e

# Color codes for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

ENVIRONMENT=${1:-staging}
COMPONENT=${2:-all}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Configuration
PROJECT_ID="detroit-automation-academy"
GCP_REGION="us-central1"
STAGING_BUCKET="gs://daa-staging"
PROD_BUCKET="gs://daa-production"

# Domains mapping
declare -A DOMAINS=(
    ["landing"]="https://detroitautomationacademy.com"
    ["blog"]="https://blog.detroitautomationacademy.com"
    ["enrollment"]="https://enroll.detroitautomationacademy.com"
)

echo -e "${BLUE}🚀 DAA EPOCH VII Deployment Script${NC}"
echo "Environment: $ENVIRONMENT"
echo "Component: $COMPONENT"
echo "Timestamp: $TIMESTAMP"
echo ""

# Function: Build landing page
build_landing() {
    echo -e "${BLUE}📄 Building landing page...${NC}"
    # Copy index.html and dependencies
    mkdir -p dist/landing
    cp index.html dist/landing/
    cp -r branding/ dist/landing/
    cp -r assets/ dist/landing/
    echo -e "${GREEN}✓ Landing page built${NC}"
}

# Function: Build blog (Hugo)
build_blog() {
    echo -e "${BLUE}📝 Building blog with Hugo...${NC}"
    cd blog-source
    hugo -d ../dist/blog --minify
    cd ..
    echo -e "${GREEN}✓ Blog built (Hugo)${NC}"
}

# Function: Build enrollment page
build_enrollment() {
    echo -e "${BLUE}📋 Building enrollment page...${NC}"
    mkdir -p dist/enrollment
    cp enroll.html dist/enrollment/index.html
    cp -r branding/ dist/enrollment/
    echo -e "${GREEN}✓ Enrollment page built${NC}"
}

# Function: Deploy to staging
deploy_staging() {
    local component=$1
    echo -e "${BLUE}🔄 Deploying to staging ($ENVIRONMENT)...${NC}"
    
    if [[ "$component" == "landing" ]] || [[ "$component" == "all" ]]; then
        gsutil -m cp -r dist/landing/* "$STAGING_BUCKET/landing/"
        echo -e "${GREEN}✓ Landing deployed to staging${NC}"
    fi
    
    if [[ "$component" == "blog" ]] || [[ "$component" == "all" ]]; then
        gsutil -m cp -r dist/blog/* "$STAGING_BUCKET/blog/"
        echo -e "${GREEN}✓ Blog deployed to staging${NC}"
    fi
    
    if [[ "$component" == "enrollment" ]] || [[ "$component" == "all" ]]; then
        gsutil -m cp -r dist/enrollment/* "$STAGING_BUCKET/enrollment/"
        echo -e "${GREEN}✓ Enrollment deployed to staging${NC}"
    fi
}

# Function: Deploy to production
deploy_production() {
    local component=$1
    echo -e "${RED}⚠️  PRODUCTION DEPLOYMENT - Requesting confirmation...${NC}"
    
    read -p "Deploy $component to PRODUCTION? (yes/no): " confirm
    if [[ "$confirm" != "yes" ]]; then
        echo -e "${RED}❌ Deployment cancelled${NC}"
        return 1
    fi
    
    echo -e "${BLUE}🔄 Deploying to production...${NC}"
    
    if [[ "$component" == "landing" ]] || [[ "$component" == "all" ]]; then
        gsutil -m cp -r dist/landing/* "$PROD_BUCKET/landing/"
        gcloud compute backend-buckets update daa-landing --cloud-cdn-enabled
        echo -e "${GREEN}✓ Landing deployed to production${NC}"
    fi
    
    if [[ "$component" == "blog" ]] || [[ "$component" == "all" ]]; then
        gsutil -m cp -r dist/blog/* "$PROD_BUCKET/blog/"
        gcloud compute backend-buckets update daa-blog --cloud-cdn-enabled
        echo -e "${GREEN}✓ Blog deployed to production${NC}"
    fi
    
    if [[ "$component" == "enrollment" ]] || [[ "$component" == "all" ]]; then
        gsutil -m cp -r dist/enrollment/* "$PROD_BUCKET/enrollment/"
        gcloud compute backend-buckets update daa-enrollment --cloud-cdn-enabled
        echo -e "${GREEN}✓ Enrollment deployed to production${NC}"
    fi
}

# Function: Verify deployment
verify_deployment() {
    echo -e "${BLUE}✓ Verifying deployment...${NC}"
    
    if [[ "$COMPONENT" == "landing" ]] || [[ "$COMPONENT" == "all" ]]; then
        echo "Testing ${DOMAINS[landing]}..."
        if curl -s -o /dev/null -w "%{http_code}" "${DOMAINS[landing]}" | grep -q "200"; then
            echo -e "${GREEN}✓ Landing page responding (HTTP 200)${NC}"
        fi
    fi
    
    if [[ "$COMPONENT" == "blog" ]] || [[ "$COMPONENT" == "all" ]]; then
        echo "Testing ${DOMAINS[blog]}..."
        if curl -s -o /dev/null -w "%{http_code}" "${DOMAINS[blog]}" | grep -q "200"; then
            echo -e "${GREEN}✓ Blog responding (HTTP 200)${NC}"
        fi
    fi
    
    if [[ "$COMPONENT" == "enrollment" ]] || [[ "$COMPONENT" == "all" ]]; then
        echo "Testing ${DOMAINS[enrollment]}..."
        if curl -s -o /dev/null -w "%{http_code}" "${DOMAINS[enrollment]}" | grep -q "200"; then
            echo -e "${GREEN}✓ Enrollment page responding (HTTP 200)${NC}"
        fi
    fi
}

# Function: Purge CDN cache
purge_cdn() {
    echo -e "${BLUE}🔄 Purging CDN cache...${NC}"
    
    if [[ "$ENVIRONMENT" == "production" ]]; then
        gcloud compute url-maps invalidate-cdn-cache daa-prod --async
        echo -e "${GREEN}✓ CDN cache purge initiated${NC}"
    fi
}

# Main execution
main() {
    case "$COMPONENT" in
        landing|blog|enrollment|all)
            [[ "$COMPONENT" == "landing" ]] || [[ "$COMPONENT" == "all" ]] && build_landing
            [[ "$COMPONENT" == "blog" ]] || [[ "$COMPONENT" == "all" ]] && build_blog
            [[ "$COMPONENT" == "enrollment" ]] || [[ "$COMPONENT" == "all" ]] && build_enrollment
            
            if [[ "$ENVIRONMENT" == "staging" ]]; then
                deploy_staging "$COMPONENT"
            elif [[ "$ENVIRONMENT" == "production" ]]; then
                deploy_production "$COMPONENT"
            fi
            
            verify_deployment
            purge_cdn
            
            echo ""
            echo -e "${GREEN}✅ Deployment complete!${NC}"
            echo "Timestamp: $TIMESTAMP"
            ;;
        *)
            echo -e "${RED}❌ Invalid component: $COMPONENT${NC}"
            echo "Usage: ./deploy.sh [staging|production] [landing|blog|enrollment|all]"
            exit 1
            ;;
    esac
}

# Run main
main
