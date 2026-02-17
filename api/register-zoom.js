// /api/register-zoom.js
// Vercel serverless function — registers a user for a Zoom meeting occurrence (recurring meeting).
// Uses Zoom Server-to-Server OAuth to fetch an access token on-demand.
//
// Required env vars (set in Vercel Project Settings → Environment Variables):
// - ZOOM_ACCOUNT_ID
// - ZOOM_CLIENT_ID
// - ZOOM_CLIENT_SECRET
// - ZOOM_MEETING_ID
//
// Notes:
// - This picks the closest occurrence by start_time to the client-provided sessionTimeSelected ISO string.
// - Expects POST JSON body: { fullName, email, role?, sessionTimeSelected }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { fullName, email, role, sessionTimeSelected } = req.body || {};

    if (!fullName || !email || !sessionTimeSelected) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: fullName, email, sessionTimeSelected'
      });
    }

    const MEETING_ID = process.env.ZOOM_MEETING_ID;
    const ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
    const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
    const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

    if (!MEETING_ID || !ACCOUNT_ID || !CLIENT_ID || !CLIENT_SECRET) {
      console.error('Missing Zoom env vars', {
        hasMeetingId: !!MEETING_ID,
        hasAccountId: !!ACCOUNT_ID,
        hasClientId: !!CLIENT_ID,
        hasClientSecret: !!CLIENT_SECRET
      });
      return res.status(500).json({ success: false, error: 'Server configuration error' });
    }

    // Parse name
    const nameParts = String(fullName).trim().split(/\s+/);
    const first_name = nameParts[0] || '';
    const last_name = nameParts.slice(1).join(' ') || '';

    // Get access token (Server-to-Server OAuth)
    const TOKEN = await getZoomAccessToken({
      accountId: ACCOUNT_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET
    });

    // Step 1: Get meeting details (including occurrences)
    const meetingRes = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(MEETING_ID)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    if (!meetingRes.ok) {
      const errText = await meetingRes.text();
      console.error('Zoom GET meeting failed:', meetingRes.status, errText);
      return res.status(500).json({ success: false, error: 'Failed to fetch Zoom meeting details' });
    }

    const meetingData = await meetingRes.json();
    const occurrences = Array.isArray(meetingData.occurrences) ? meetingData.occurrences : [];

    // Step 2: Match occurrence by closest start_time to sessionTimeSelected
    const targetTime = new Date(sessionTimeSelected).getTime();
    if (!Number.isFinite(targetTime)) {
      return res.status(400).json({ success: false, error: 'Invalid sessionTimeSelected timestamp' });
    }

    let bestOccurrence = null;
    let bestDiff = Infinity;

    for (const occ of occurrences) {
      const occTime = new Date(occ.start_time).getTime();
      if (!Number.isFinite(occTime)) continue;
      const diff = Math.abs(occTime - targetTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestOccurrence = occ;
      }
    }

    // Optional guardrail: if we found an occurrence but it's wildly far away, fail rather than register wrong.
    // 6 hours is generous; adjust if you want stricter.
    const MAX_DIFF_MS = 6 * 60 * 60 * 1000;
    if (bestOccurrence && bestDiff > MAX_DIFF_MS) {
      console.error('Occurrence match too far from target', {
        target: sessionTimeSelected,
        best: bestOccurrence.start_time,
        bestDiffMs: bestDiff
      });
      return res.status(400).json({
        success: false,
        error: 'Selected session time does not match any Zoom occurrence'
      });
    }

    // Build registration body
    const regBody = {
      email,
      first_name,
      last_name
    };

    // Add role as a custom question if provided (Zoom must have matching custom question configured to store it)
    // Safe to omit if you haven't configured custom questions in Zoom registration settings.
    if (role) {
      regBody.custom_questions = [{ title: 'Role', value: role }];
    }

    // Build URL with occurrence_id if found
    let regUrl = `https://api.zoom.us/v2/meetings/${encodeURIComponent(MEETING_ID)}/registrants`;
    if (bestOccurrence && bestOccurrence.occurrence_id) {
      regUrl += `?occurrence_ids=${encodeURIComponent(bestOccurrence.occurrence_id)}`;
    }

    // Step 3: Register
    const regRes = await fetch(regUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(regBody)
    });

    if (!regRes.ok) {
      const errText = await regRes.text();
      console.error('Zoom registration failed:', regRes.status, errText);
      return res.status(500).json({ success: false, error: 'Zoom registration failed' });
    }

    const regData = await regRes.json();

    return res.status(200).json({
      success: true,
      join_url: regData.join_url || '',
      registrant_id: regData.registrant_id || regData.id || '',
      occurrence_id: bestOccurrence ? bestOccurrence.occurrence_id : '',
      // Helpful debug fields (remove if you don't want them):
      matched_start_time: bestOccurrence ? bestOccurrence.start_time : ''
    });
  } catch (err) {
    console.error('register-zoom error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
}

async function getZoomAccessToken({ accountId, clientId, clientSecret }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const tokenRes = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Zoom token error: ${tokenRes.status} ${errText}`);
  }

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    throw new Error('Zoom token response missing access_token');
  }

  return tokenData.access_token;
}
