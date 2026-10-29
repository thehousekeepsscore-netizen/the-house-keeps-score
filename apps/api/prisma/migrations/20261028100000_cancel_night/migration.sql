-- A night opened by mistake had no way out: settle refuses fewer than two
-- players, and the club cannot open another night while one is active. This
-- adds the status a cancelled night rests in. Additive only; no row changes.
ALTER TYPE "SessionStatus" ADD VALUE 'cancelled';
