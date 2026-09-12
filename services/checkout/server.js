require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const port = Number(process.env.PORT || 4242);
const clientUrl = (process.env.CLIENT_URL || 'https://detroitautomationacademy.com').replace(/\/$/, '');
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || `${clientUrl},https://www.detroitautomationacademy.com,http://localhost:3000`)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const processedEvents = new Set();

const plans = Object.freeze({
  educator: {
    name: 'Educator Pack',
    priceId: process.env.STRIPE_PRICE_EDUCATOR,
  },
  academy: {
    name: 'Academy-in-a-Box',
    priceId: process.env.STRIPE_PRICE_ACADEMY,
  },
});

function jsonError(message, status = 400) {
  return { error: message, status };
}

function validateCheckoutRequest(body) {
  const plan = typeof body.plan === 'string' ? plans[body.plan] : null;
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const organizationName = typeof body.organization_name === 'string'
    ? body.organization_name.trim()
    : '';

  if (!plan) return jsonError('Choose a valid subscription plan.');
  if (!plan.priceId) return jsonError('This subscription is not configured yet.', 503);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonError('Enter a valid billing email.');
  }
  if (organizationName.length < 2 || organizationName.length > 120) {
    return jsonError('Enter an organization name between 2 and 120 characters.');
  }

  return { plan, email, organizationName };
}

async function createCheckoutSession(req, res) {
  if (!stripe) return res.status(503).json({ error: 'Checkout is not configured.' });

  const validated = validateCheckoutRequest(req.body || {});
  if (validated.error) return res.status(validated.status).json({ error: validated.error });

  const requestId = req.get('Idempotency-Key') || crypto.randomUUID();
  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        line_items: [{ price: validated.plan.priceId, quantity: 1 }],
        customer_email: validated.email,
        success_url: `${clientUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/subscriptions.html`,
        metadata: {
          organization_name: validated.organizationName,
          plan: validated.plan.name,
        },
        subscription_data: {
          metadata: {
            organization_name: validated.organizationName,
            plan: validated.plan.name,
          },
        },
      },
      { idempotencyKey: `checkout-${requestId}` },
    );

    return res.status(201).json({ url: session.url });
  } catch (error) {
    console.error('checkout_session_creation_failed', error);
    return res.status(502).json({ error: 'Unable to start checkout. Please try again.' });
  }
}

async function fulfillCheckoutSession(session) {
  if (!session || session.payment_status !== 'paid') return;

  console.log(JSON.stringify({
    event: 'checkout_fulfillment_required',
    sessionId: session.id,
    customerId: session.customer,
    subscriptionId: session.subscription,
    organizationName: session.metadata?.organization_name,
    plan: session.metadata?.plan,
  }));
  // Add the production entitlement/email adapter here. Stripe retries this event,
  // so fulfillment must use session.id as its durable idempotency key.
}

async function handleStripeEvent(event) {
  if (processedEvents.has(event.id)) return;
  processedEvents.add(event.id);

  switch (event.type) {
    case 'checkout.session.completed':
      await fulfillCheckoutSession(event.data.object);
      break;
    case 'invoice.paid':
      console.log(JSON.stringify({ event: 'subscription_renewed', invoiceId: event.data.object.id }));
      break;
    case 'invoice.payment_failed':
      console.warn(JSON.stringify({ event: 'subscription_payment_failed', invoiceId: event.data.object.id }));
      break;
    case 'customer.subscription.deleted':
      console.log(JSON.stringify({ event: 'subscription_cancelled', subscriptionId: event.data.object.id }));
      break;
    default:
      break;
  }
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed.'));
  },
}));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'daa-checkout' }));

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Webhook is not configured.');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    console.error('stripe_webhook_signature_failed', error.message);
    return res.status(400).send('Invalid webhook signature.');
  }

  try {
    await handleStripeEvent(event);
    return res.json({ received: true });
  } catch (error) {
    processedEvents.delete(event.id);
    console.error('stripe_webhook_processing_failed', error);
    return res.status(500).send('Webhook processing failed.');
  }
});

app.use(express.json({ limit: '32kb' }));
app.post('/api/create-checkout-session', createCheckoutSession);

app.use((error, _req, res, _next) => {
  if (error.message === 'Origin is not allowed.') return res.status(403).json({ error: error.message });
  console.error('checkout_request_failed', error);
  return res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(port, () => console.log(`DAA checkout service listening on port ${port}`));