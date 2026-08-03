import { collection, getDocs, query, where, setDoc, doc, updateDoc, addDoc } from 'firebase/firestore';
import { db } from './firebase';

export interface PaybackEntry {
  from: string;
  to: string;
  amount: number;
}

export const PDF_PAYBACKS: PaybackEntry[] = [
  { from: 'Addu', to: 'Parshv Lalwani', amount: 67000 },
  { from: 'Bhanu', to: 'Aniket', amount: 102000 },
  { from: 'Bhavya Nandu', to: 'Jainy', amount: 21388.90 },
  { from: 'Bhavya Nandu', to: 'Parshv Lalwani', amount: 2611.10 },
  { from: 'Hemang', to: 'Bafna', amount: 320000 },
  { from: 'Poras Shah', to: 'Pot', amount: 81300 },
  { from: 'Poras Shah', to: 'Parshv Lalwani', amount: 3800 },
  { from: 'Raj', to: 'Bafna', amount: 51547.58 },
  { from: 'Rajen', to: 'Aniket', amount: 12096.30 },
  { from: 'Rajen', to: 'Bafna', amount: 7016.67 },
  { from: 'Rajen', to: 'Sangini', amount: 1695.71 },
  { from: 'Rajen', to: 'Parshv Lalwani', amount: 191.32 },
  { from: 'Rushi', to: 'Rohinish', amount: 15938.30 },
  { from: 'Rushi', to: 'Sangini', amount: 5061.70 },
  { from: 'Yash', to: 'Rohinish', amount: 179500 },
  { from: 'Yogi', to: 'Jainy', amount: 37000 }
];

export async function seedPDFHistoryToClub(clubId: string, currentUserId: string = 'system') {
  try {
    // Check if Day 1 record already exists for this club
    const q = query(
      collection(db, 'historical_records'),
      where('clubId', '==', clubId),
      where('sessionDate', '==', '2026-07-25')
    );
    const snap = await getDocs(q);

    if (!snap.empty) {
      console.log('PDF Historical records already seeded for club:', clubId);
      return false;
    }

    // 1. Seed Day 1 Session Record (25 July 2026)
    const day1Ref = doc(collection(db, 'historical_records'));
    await setDoc(day1Ref, {
      clubId,
      sessionDate: '2026-07-25',
      sessionTitle: 'Day 1',
      sessionType: 'Offline Session',
      dayNumber: 1,
      playerStats: [
        { userName: 'Aniket', totalBuyIn: 0, cashOut: 89300, profit: 89300 },
        { userName: 'Poras Shah', totalBuyIn: 0, cashOut: 96900, profit: 96900 },
        { userName: 'Parshv Lalwani', totalBuyIn: 0, cashOut: 69350, profit: 69350 },
        { userName: 'Bafna', totalBuyIn: 0, cashOut: 950, profit: 950 },
        { userName: 'Rohinish', totalBuyIn: 8000, cashOut: 0, profit: -8000 },
        { userName: 'Sangini', totalBuyIn: 10000, cashOut: 0, profit: -10000 },
        { userName: 'Jainy', totalBuyIn: 20000, cashOut: 0, profit: -20000 },
        { userName: 'Rushi', totalBuyIn: 20000, cashOut: 0, profit: -20000 },
        { userName: 'Bhavya Nandu', totalBuyIn: 23000, cashOut: 0, profit: -23000 },
        { userName: 'Yash', totalBuyIn: 27500, cashOut: 0, profit: -27500 },
        { userName: 'Bhanu', totalBuyIn: 50000, cashOut: 0, profit: -50000 },
        { userName: 'Addu', totalBuyIn: 55000, cashOut: 0, profit: -55000 },
        { userName: 'Raj', totalBuyIn: 90000, cashOut: 38452.42, profit: -51547.58 }
      ],
      notes: 'Imported from 25th July PDF Expenses Ledger',
      importedBy: currentUserId,
      createdAt: '2026-07-25T20:00:00.000Z'
    });

    // 2. Seed Day 2 Session Record (26 July 2026)
    const day2Ref = doc(collection(db, 'historical_records'));
    await setDoc(day2Ref, {
      clubId,
      sessionDate: '2026-07-26',
      sessionTitle: 'Day 2',
      sessionType: 'Offline Session',
      dayNumber: 2,
      playerStats: [
        { userName: 'Bafna', totalBuyIn: 26135.75, cashOut: 404700, profit: 378564.25 },
        { userName: 'Rohinish', totalBuyIn: 23061.70, cashOut: 218500, profit: 195438.30 },
        { userName: 'Jainy', totalBuyIn: 27111.10, cashOut: 85500, profit: 58388.90 },
        { userName: 'Aniket', totalBuyIn: 3703.70, cashOut: 28500, profit: 24796.30 },
        { userName: 'Sangini', totalBuyIn: 13192.59, cashOut: 19950, profit: 16757.41 },
        { userName: 'Parshv Lalwani', totalBuyIn: 2397.58, cashOut: 6650, profit: 4252.42 },
        { userName: 'Raj', totalBuyIn: 1000, cashOut: 1000, profit: 0 },
        { userName: 'Rushi', totalBuyIn: 1000, cashOut: 0, profit: -1000 },
        { userName: 'Bhavya Nandu', totalBuyIn: 1000, cashOut: 0, profit: -1000 },
        { userName: 'Addu', totalBuyIn: 12000, cashOut: 0, profit: -12000 },
        { userName: 'Rajen', totalBuyIn: 21000, cashOut: 0, profit: -21000 },
        { userName: 'Yogi', totalBuyIn: 37000, cashOut: 0, profit: -37000 },
        { userName: 'Bhanu', totalBuyIn: 52000, cashOut: 0, profit: -52000 },
        { userName: 'Yash', totalBuyIn: 152000, cashOut: 0, profit: -152000 },
        { userName: 'Poras Shah', totalBuyIn: 182000, cashOut: 0, profit: -182000 },
        { userName: 'Hemang', totalBuyIn: 320000, cashOut: 0, profit: -320000 }
      ],
      notes: 'Imported from 26th July PDF Expenses Ledger',
      importedBy: currentUserId,
      createdAt: '2026-07-26T22:00:00.000Z'
    });

    // 3. Deposit Initial Pot Contribution
    await addDoc(collection(db, 'club_pot_logs'), {
      clubId,
      amount: 81300,
      source: 'manual_adjustment',
      note: 'PDF Historical Pot Balance (Table Entry fees & transfers)',
      createdAt: '2026-07-26T23:59:00.000Z'
    });

    // Update Club Pot balance to 81,300
    await updateDoc(doc(db, 'clubs', clubId), {
      clubPotBalance: 81300
    });

    console.log('✅ Successfully seeded PDF history records for club:', clubId);
    return true;
  } catch (err) {
    console.error('Failed to seed PDF history:', err);
    return false;
  }
}
