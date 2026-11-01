<?xml version="1.0" encoding="UTF-8"?>
<!--
  feed.xsl — browser rendering for the Detroit Automation Academy RSS feed.

  feed.xml declares this stylesheet through an xml-stylesheet processing
  instruction, so opening the feed in a browser shows this formatted page.
  Feed readers ignore the stylesheet and receive the raw RSS XML exactly
  as before; this file only changes how a browser displays the feed.
-->
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" encoding="UTF-8" indent="yes" />

  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title><xsl:value-of select="rss/channel/title" /> — RSS feed</title>
        <style>
          :root { color-scheme: dark; }
          * { box-sizing: border-box; }
          body { margin: 0; background: #0C1116; color: #F5F2EA;
            font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial,
            sans-serif; line-height: 1.55; }
          a { color: #FFB000; }
          header, main, footer { max-width: 760px; margin: 0 auto;
            padding: 0 20px; }
          header { padding-top: 36px; }
          .logo { border-radius: 14px; }
          h1 { margin: 10px 0 6px; font-size: 30px; }
          .tagline { color: #9AA0A6; margin: 0 0 18px; }
          nav.main-nav { display: flex; flex-wrap: wrap; gap: 8px;
            margin: 0 0 22px; }
          nav.main-nav a { color: #F5F2EA; text-decoration: none;
            border: 1px solid #2a333d; padding: 6px 12px;
            border-radius: 999px; font-size: 14px; }
          nav.main-nav a:hover { border-color: #E85D1A; color: #FFB000; }
          .subscribe { background: #131a21; border: 1px solid #2a333d;
            border-radius: 14px; padding: 16px 18px; margin: 0 0 28px; }
          .subscribe h2 { margin: 0 0 8px; font-size: 16px; color: #E85D1A; }
          .subscribe p { margin: 6px 0; font-size: 14px; color: #9AA0A6; }
          .subscribe .readers a { margin-right: 14px; font-weight: 600; }
          code.feed-url { display: block; margin-top: 8px; background: #0C1116;
            border: 1px solid #2a333d; border-radius: 8px; padding: 8px 10px;
            color: #F5F2EA; font-size: 13px; word-break: break-all;
            user-select: all; }
          .card { background: #131a21; border: 1px solid #2a333d;
            border-radius: 14px; padding: 18px 20px; margin: 0 0 16px; }
          .card .meta { display: flex; gap: 12px; align-items: center;
            margin-bottom: 8px; }
          .chip { background: #E85D1A; color: #0C1116; text-decoration: none;
            font-size: 12px; font-weight: 700; padding: 3px 10px;
            border-radius: 999px; text-transform: uppercase;
            letter-spacing: .04em; }
          .card time { color: #9AA0A6; font-size: 13px; }
          .card h2 { margin: 0 0 8px; font-size: 21px; line-height: 1.3; }
          .card h2 a { color: #F5F2EA; text-decoration: none; }
          .card h2 a:hover { color: #FFB000; }
          .card p { margin: 0 0 10px; color: #d8d4c9; }
          .card .read { font-weight: 600; }
          footer { padding-top: 8px; padding-bottom: 40px; color: #9AA0A6;
            font-size: 14px; }
        </style>
      </head>
      <body>
        <header>
          <xsl:if test="rss/channel/image/url">
            <img class="logo" src="{rss/channel/image/url}"
              alt="Detroit Automation Academy" width="72" height="72" />
          </xsl:if>
          <h1><xsl:value-of select="rss/channel/title" /></h1>
          <p class="tagline">
            <xsl:value-of select="rss/channel/description" />
          </p>
          <nav class="main-nav">
            <a href="/">Home</a>
            <a href="/signal/">The Signal</a>
            <a href="/live-transit-detroit/">Live Transit Detroit</a>
            <a href="/notes/">Notes</a>
            <a href="/find.html">Find</a>
            <a href="/live-transit.html">Live Transit map</a>
          </nav>
          <div class="subscribe">
            <h2>Subscribe</h2>
            <p class="readers">
              <a href="https://feedly.com/i/subscription/feed/https%3A%2F%2Fwww.detroitautomationacademy.com%2Ffeed.xml">Add to Feedly</a>
              <a href="https://www.inoreader.com/?add_feed=https%3A%2F%2Fwww.detroitautomationacademy.com%2Ffeed.xml">Add to Inoreader</a>
              <a href="https://newsblur.com/?url=https%3A%2F%2Fwww.detroitautomationacademy.com%2Ffeed.xml">Add to NewsBlur</a>
            </p>
            <p>Or paste this feed address into any feed reader:</p>
            <code class="feed-url">https://www.detroitautomationacademy.com/feed.xml</code>
          </div>
        </header>
        <main>
          <xsl:for-each select="rss/channel/item">
            <xsl:variable name="hub">
              <xsl:choose>
                <xsl:when test="category = 'Live Transit Detroit'">/live-transit-detroit/</xsl:when>
                <xsl:when test="category = 'Notes'">/notes/</xsl:when>
                <xsl:otherwise>/signal/</xsl:otherwise>
              </xsl:choose>
            </xsl:variable>
            <article class="card">
              <div class="meta">
                <a class="chip" href="{$hub}">
                  <xsl:value-of select="category" />
                </a>
                <time>
                  <xsl:value-of
                    select="substring(substring-after(pubDate, ', '), 1, 11)" />
                </time>
              </div>
              <h2>
                <a href="{link}"><xsl:value-of select="title" /></a>
              </h2>
              <p><xsl:value-of select="description" /></p>
              <p><a class="read" href="{link}">Read on the site</a></p>
            </article>
          </xsl:for-each>
        </main>
        <footer>
          <p>
            <a href="https://www.detroitautomationacademy.com/">Detroit Automation Academy</a>
            — robotics, drones, and automation training for Detroit's young
            builders.
          </p>
          <p>
            You are viewing the browser rendering of this site's RSS feed.
            Feed readers receive the same feed as raw XML — this stylesheet
            only changes how the feed appears when opened in a browser.
          </p>
        </footer>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
