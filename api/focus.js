import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let db;
try {
  const app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
  db = getFirestore(app);
} catch (e) {
  console.error('Firebase init failed:', e);
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.FOCUS_API_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const doc = await db.collection('chope').doc('main').get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'document not found' });
    }
    const weekFocus = doc.data().weekFocus || {};
    
    const today = new Date().toISOString().split('T')[0];
    let entry = weekFocus[today];
    if (!entry) {
      const dates = Object.keys(weekFocus).sort().reverse();
      for (const d of dates) {
        if (d <= today) {
          entry = weekFocus[d];
          break;
        }
      }
    }
    
    if (!entry) {
      return res.json({ week: 'No focus set', focus: [], linkedTasks: [] });
    }

    res.json({
      week: today,
      text: entry.text,
      linkedTasks: entry.taskIds || [],
      updatedAt: entry.updatedAt,
    });
  } catch (e) {
    console.error('Firestore read failed:', e);
    res.status(500).json({ error: e.message });
  }
}