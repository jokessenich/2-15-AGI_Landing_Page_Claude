// /api/register-zoom.js
// Vercel serverless function — registers a user for a Zoom meeting occurrence.
// Env vars required: ZOOM_ACCESS_TOKEN, ZOOM_MEETING_ID

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const {
      fullName,
      email,
      role,
      sessionTimeSelected
    } = req.body;

    if (!fullName || !email || !sessionTimeSelected) {
      return res.status(400).json({ success: false, error: 'Missing required fields: fullName, email, sessionTimeSelected' });
    }

    const MEETING_ID = process.env.ZOOM_MEETING_ID;
    const TOKEN = process.env.ZOOM_ACCESS_TOKEN;

    if (!MEETING_ID || !TOKEN) {
      console.error('Missing ZOOM_MEETING_ID or ZOOM_ACCESS_TOKEN env vars');
      return res.status(500).json({ success: false, error: 'Server configuration error' });
    }

    // Parse name
    const nameParts = fullName.trim().split(/\s+/);
    const first_name = nameParts[0] || '';
    const last_name = nameParts.slice(1).join(' ') || '';

    // Step 1: Get meeting occurrences
    const meetingRes = await fetch(`https://api.zoom.us/v2/meetings/${MEETING_ID}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    if (!meetingRes.ok) {
      const errText = await meetingRes.text();
      console.error('Zoom GET meeting failed:', meetingRes.status, errText);
      return res.status(500).json({ success: false, error: 'Failed to fetch Zoom meeting details' });
    }

    const meetingData = await meetingRes.json();
    const occurrences = meetingData.occurrences || [];

    // Step 2: Match occurrence by closest start_time to sessionTimeSelected
    const targetTime = new Date(sessionTimeSelected).getTime();
    let bestOccurrence = null;
    let bestDiff = Infinity;

    for (const occ of occurrences) {
      const occTime = new Date(occ.start_time).getTime();
      const diff = Math.abs(occTime - targetTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestOccurrence = occ;
      }
    }

    // Build registration body
    const regBody = {
      email,
      first_name,
      last_name
    };

    if (role) {
      regBody.custom_questions = [{ title: 'Role', value: role }];
    }

    // Build URL with occurrence_id if found
    let regUrl = `https://api.zoom.us/v2/meetings/${MEETING_ID}/registrants`;
    if (bestOccurrence) {
      regUrl += `?occurrence_ids=${bestOccurrence.occurrence_id}`;
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
      occurrence_id: bestOccurrence ? bestOccurrence.occurrence_id : ''
    });
  } catch (err) {
    console.error('register-zoom error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
}
