(function () {
    'use strict';

    const plans = {
        educator: { name: 'Educator Pack', price: '$29/mo' },
        academy: { name: 'Academy-in-a-Box', price: '$149/mo' }
    };
    const apiUrl = (window.DAA_CHECKOUT_API_URL || 'https://checkout.detroitautomationacademy.com').replace(/\/$/, '');
    let selectedPlan = null;

    const modal = document.getElementById('checkout-modal');
    const form = document.getElementById('checkout-form');
    const errorMessage = document.getElementById('checkout-error');
    const submitButton = document.getElementById('checkout-submit');
    const closeButtons = document.querySelectorAll('[data-checkout-close]');
    let previouslyFocusedElement = null;

    window.closeCheckout = function () {
        if (!modal) return;
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        if (errorMessage) errorMessage.classList.remove('is-visible');
        if (previouslyFocusedElement) previouslyFocusedElement.focus();
    };

    window.contactSales = function (tier) {
        window.location.href = `mailto:info@detroitautomationacademy.com?subject=${encodeURIComponent(`Enterprise Inquiry: ${tier}`)}`;
    };

    function openCheckout(planKey) {
        const plan = plans[planKey];
        if (!plan || !modal) return;
        selectedPlan = planKey;
        document.getElementById('modal-tier-name').textContent = plan.name;
        document.getElementById('modal-tier-price').textContent = plan.price;
        previouslyFocusedElement = document.activeElement;
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        document.getElementById('organization-name').focus();
    }

    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.classList.add('is-visible');
    }

    closeButtons.forEach(function (button) {
        button.addEventListener('click', window.closeCheckout);
    });

    if (modal) {
        modal.addEventListener('click', function (event) {
            if (event.target === modal) window.closeCheckout();
        });
    }

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && modal && modal.classList.contains('is-open')) {
            window.closeCheckout();
        }
    });

    document.querySelectorAll('[data-checkout-plan]').forEach(function (button) {
        button.addEventListener('click', function () {
            openCheckout(button.dataset.checkoutPlan);
        });
    });

    if (form) {
        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            if (!selectedPlan) return showError('Choose a subscription plan first.');
            errorMessage.classList.remove('is-visible');
            submitButton.disabled = true;
            submitButton.textContent = 'Opening secure checkout...';

            try {
                const response = await fetch(`${apiUrl}/api/create-checkout-session`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Idempotency-Key': crypto.randomUUID()
                    },
                    body: JSON.stringify({
                        plan: selectedPlan,
                        organization_name: document.getElementById('organization-name').value,
                        email: document.getElementById('billing-email').value
                    })
                });
                const payload = await response.json();
                if (!response.ok || !payload.url) throw new Error(payload.error || 'Checkout is unavailable.');
                window.location.assign(payload.url);
            } catch (error) {
                showError(error.message || 'Checkout is unavailable. Please try again.');
                submitButton.disabled = false;
                submitButton.textContent = 'Continue to secure checkout';
            }
        });
    }
}());