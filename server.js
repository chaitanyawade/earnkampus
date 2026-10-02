/**
 * EarnCampus — Local development server entry point.
 *
 * IMPORTANT for production / Vercel:
 * Set SESSION_SECRET to a long random string in your environment:
 *   export SESSION_SECRET="<your-random-secret>"
 * Do NOT commit a real secret to source control.
 *
 * For Vercel, also set ALLOWED_ORIGINS to your deployed domain:
 *   ALLOWED_ORIGINS=https://your-app.vercel.app
 */

'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const app = require('./api/index.js');

const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  if (!process.env.SESSION_SECRET) {
    console.warn(
      '[EarnCampus] WARNING: SESSION_SECRET environment variable is not set.\n' +
      '  Using a dev-only default. Set a strong secret for production!'
    );
  }
  app.listen(PORT, () => {
    console.log(`EarnCampus Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
