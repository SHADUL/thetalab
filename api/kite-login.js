/**
 * Entry point for "Connect Kite" — redirects to Zerodha's own login page.
 * api_key is not secret (Kite's own docs embed it directly in this login
 * URL); routing through here anyway means the frontend never needs to know
 * it at all, and the one place that does (this function) never ships to
 * the browser.
 */
export default function handler(req, res) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    res.status(500).send('KITE_API_KEY is not configured on the server.');
    return;
  }
  res.writeHead(302, { Location: `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3` });
  res.end();
}
