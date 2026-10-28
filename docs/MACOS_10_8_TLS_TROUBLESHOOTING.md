# macOS 10.8 TLS Troubleshooting

macOS 10.8 (Mountain Lion) commonly ships with OpenSSL 0.9.8. That version does not support the `-tls1_2` option, so the system `openssl` and an older system `curl` may be unable to negotiate TLS with modern web servers such as `www.detroitautomationacademy.com`.

This is a limitation of the local client. It does not indicate a problem with the site's certificate or TLS configuration.

## 1. Check the Installed OpenSSL Version

```bash
openssl version
```

If the output begins with `OpenSSL 0.9.8`, use one of the workarounds below. Do not interpret a failed `openssl s_client` test from that binary as proof that the site is unavailable.

## 2. Option A: Install Modern OpenSSL and cURL with MacPorts

If MacPorts is already installed on the Mountain Lion machine:

```bash
sudo port selfupdate
sudo port install openssl curl
```

Invoke the MacPorts binary explicitly rather than relying on the system `PATH`:

```bash
/opt/local/bin/curl -Iv https://www.detroitautomationacademy.com
```

For a TLS protocol-specific check, use the MacPorts OpenSSL binary when it is available:

```bash
/opt/local/bin/openssl version
/opt/local/bin/openssl s_client -connect www.detroitautomationacademy.com:443 \
  -servername www.detroitautomationacademy.com -tls1_2
```

The exact OpenSSL path can vary by MacPorts version. Confirm it with `which openssl` or `port contents openssl` if `/opt/local/bin/openssl` is not present.

## 3. Option B: Use a Modern Local Proxy

When installing replacement binaries is not practical, run a proxy such as mitmproxy or Squid on a modern computer or Raspberry Pi on the same network. For example, if the proxy listens at `192.168.1.50:8080`:

```bash
curl -x http://192.168.1.50:8080 -Iv \
  https://www.detroitautomationacademy.com
```

The proxy performs the modern TLS handshake and relays the response to the Mountain Lion client. If the proxy decrypts HTTPS traffic, install and trust its CA certificate on the test machine only when that is appropriate for the environment. Never send credentials or sensitive data through an untrusted proxy.

## 4. Server-Side Resolution: Isolated Compatibility Proxy

The primary site should continue to require TLS 1.2 or newer. Do not lower the TLS policy on the production GitHub Pages or Google-managed load-balancer endpoint: that would weaken every client connection and may not be supported by the hosting provider.

For read-only legacy access, operate a reverse proxy on a maintained modern VM or appliance. Give it a separate hostname such as `legacy-tls.detroitautomationacademy.com`, provision a certificate for that hostname, and configure it to:

1. Accept TLS 1.0 only on the compatibility listener.
2. Allow only the minimum legacy cipher set required by the Mountain Lion client.
3. Forward requests to `https://www.detroitautomationacademy.com` using TLS 1.2 or newer.
4. Redirect or deny credentials, enrollment, checkout, administration, and other sensitive paths.
5. Restrict access by source IP or VPN and monitor the endpoint for removal.

Conceptual Nginx configuration on the modern proxy host:

```nginx
server {
  listen 443 ssl;
  server_name legacy-tls.detroitautomationacademy.com;

  ssl_certificate     /etc/letsencrypt/live/legacy-tls.detroitautomationacademy.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/legacy-tls.detroitautomationacademy.com/privkey.pem;
  ssl_protocols TLSv1;

  location / {
    proxy_ssl_server_name on;
    proxy_ssl_protocols TLSv1.2 TLSv1.3;
    proxy_set_header Host www.detroitautomationacademy.com;
    proxy_pass https://www.detroitautomationacademy.com;
  }
}
```

This configuration is intentionally temporary and should be deployed only where the risk is accepted. TLS 1.0 is obsolete and must not be used for logins, forms, payments, personal data, or administrative traffic. Prefer the local MacPorts client or a modern proxy that keeps the legacy machine off the public TLS surface.

## Deployment Verification

Use the deployment checks in [PRODUCTION_DEPLOYMENT.md](../PRODUCTION_DEPLOYMENT.md) after selecting one of these workarounds. A successful HTTP response from a modern `curl` or proxy-backed request confirms reachability; it does not replace certificate validation.
