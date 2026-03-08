/* ============================================================
   WEIGHT LOSS TRACKER — app.js
   Single-file JS application. No ES modules (file:// compatible).
   All logic is organized into named module objects.

   Module map:
     CONSTANTS     — keys, version
     State         — in-memory data store
     Storage       — localStorage + JSON import/export
     Computed      — BMI, kg lost, % lost calculations
     UI            — toast, modal helpers, formatting
     Nav           — SPA page routing
     Wizard        — First-launch setup wizard
     ImportPrompt  — Returning-user import dialog
     Dashboard     — Daily entry form + summary cards
     History       — Entry table + edit/delete modal
     Charts        — Chart.js rendering (6 charts)
     Photos        — Upload, gallery, side-by-side compare
     Profile       — Profile form
     App           — Bootstrap / init
   ============================================================ */

/* ============================================================
   CONSTANTS & CONFIG
   ============================================================ */
const APP_VERSION    = '1.0';
const STORAGE_KEY    = 'weightTrackerData';   // localStorage key for state
const WIZARD_KEY     = 'weightTrackerSetupDone'; // localStorage flag

/* ============================================================
   STATE — single mutable in-memory store
   Everything the app needs lives here. Persisted to localStorage
   after every mutation. Exported/imported as JSON.
   ============================================================ */
const State = {
  profile: {
    name: '',
    dob: '',              // ISO date string YYYY-MM-DD
    heightCm: 0,
    startingWeightKg: 0,
    goalWeightKg: 0,
    weeklyGoalKg: null,   // target kg to lose per week (null = not set)
    journeyStartDate: '', // ISO date string YYYY-MM-DD
    coach: {              // Optional coach section
      enabled: false,
      name: '',
      checkInDay: 'thursday', // lowercase day name
      arrangementNotes: '',
      questionsForCoach: '', // Prep notes for next check-in session
      weeklyPlan: {
        monday:    { caloriesTarget: null, proteinTarget: null, stepsTarget: null, training: '' },
        tuesday:   { caloriesTarget: null, proteinTarget: null, stepsTarget: null, training: '' },
        wednesday: { caloriesTarget: null, proteinTarget: null, stepsTarget: null, training: '' },
        thursday:  { caloriesTarget: null, proteinTarget: null, stepsTarget: null, training: '' },
        friday:    { caloriesTarget: null, proteinTarget: null, stepsTarget: null, training: '' },
        saturday:  { caloriesTarget: null, proteinTarget: null, stepsTarget: null, training: '' },
        sunday:    { caloriesTarget: null, proteinTarget: null, stepsTarget: null, training: '' }
      }
    },
    travelMode: false,
    maintenanceCalories: null,
    mvdPresets: [
      { name: '', caloriesTarget: null, proteinTarget: null, stepsTarget: null },
      { name: '', caloriesTarget: null, proteinTarget: null, stepsTarget: null },
      { name: '', caloriesTarget: null, proteinTarget: null, stepsTarget: null }
    ]
  },
  entries: [],           // Array of entry objects, kept sorted by date ascending
  photos: [],            // Array of photo session objects { id, date, notes, front, side, back }
  charts: {}             // Holds active Chart.js instances — destroyed before re-render
};

/* ============================================================
   STORAGE — localStorage read/write + JSON file I/O
   ============================================================ */
const Storage = {
  /** Firestore document reference for current user's data. */
  _docRef() {
    const uid = firebase.auth().currentUser.uid;
    return firebase.firestore().doc(`users/${uid}/data`);
  },

  /** localStorage cache key for current user (keeps data per-user). */
  _cacheKey() {
    const uid = firebase.auth().currentUser?.uid || 'anon';
    return `wt_cache_${uid}`;
  },

  /** Load state from Firestore into State. Falls back to localStorage cache if Firestore is empty or fails. */
  async load() {
    try {
      let saved = null;
      const snap = await Storage._docRef().get();
      if (snap.exists) {
        saved = snap.data();
      } else {
        // Firestore has no data — try local cache (first load, or rules not yet set up)
        const cached = localStorage.getItem(Storage._cacheKey());
        if (cached) saved = JSON.parse(cached);
      }
      if (!saved) return false;
      if (saved.profile)  State.profile  = saved.profile;
      if (saved.entries)  State.entries  = saved.entries;
      // Photos come from localStorage (too large for Firestore)
      try {
        const rawPhotos = localStorage.getItem('weightTrackerPhotos');
        if (rawPhotos) State.photos = JSON.parse(rawPhotos);
      } catch (_) { State.photos = []; }
      // Ensure coach object exists (migration for data saved before coach feature)
      if (!State.profile.coach) {
        State.profile.coach = { enabled: false, name: '', checkInDay: 'thursday', arrangementNotes: '', questionsForCoach: '' };
      }
      if (State.profile.coach.questionsForCoach === undefined) {
        State.profile.coach.questionsForCoach = '';
      }
      if (!State.profile.coach.weeklyPlan) {
        State.profile.coach.weeklyPlan = {
          monday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          tuesday:   {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          wednesday: {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          thursday:  {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          friday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          saturday:  {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          sunday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''}
        };
      } else {
        // Migrate existing days to add fatTarget/carbsTarget if missing
        Object.keys(State.profile.coach.weeklyPlan).forEach(day => {
          const d = State.profile.coach.weeklyPlan[day];
          if (d.fatTarget   === undefined) d.fatTarget   = null;
          if (d.carbsTarget === undefined) d.carbsTarget = null;
        });
      }
      if (State.profile.travelMode === undefined) State.profile.travelMode = false;
      if (State.profile.maintenanceCalories === undefined) State.profile.maintenanceCalories = null;
      if (State.profile.weeklyGoalKg === undefined) State.profile.weeklyGoalKg = null;
      if (!State.profile.mvdPresets) {
        State.profile.mvdPresets = [
          {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null},
          {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null},
          {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null}
        ];
      }
      // Migrate old photo schema: { id, date, label, base64 } → { id, date, notes, front, side, back }
      State.photos = Storage._migratePhotos(State.photos);
      return true;
    } catch (e) {
      console.error('Storage.load error:', e);
      return false;
    }
  },

  /** Migrate photos from old flat schema to session schema. Safe to call on already-migrated data. */
  _migratePhotos(photos) {
    return photos.map(p => {
      // If old schema: has 'base64' directly on the object (not nested)
      if (p.base64 !== undefined) {
        return {
          id:    p.id,
          date:  p.date,
          notes: p.label || '',
          front: p.base64,
          side:  null,
          back:  null
        };
      }
      return p; // Already new schema
    });
  },

  /** Persist current State to Firestore + localStorage cache (fire-and-forget).
   *  Photos are stored in localStorage only (Firestore 1 MB doc limit). */
  save() {
    try {
      const data = { profile: State.profile, entries: State.entries };
      // Always write to localStorage cache first (instant, always works)
      try { localStorage.setItem(Storage._cacheKey(), JSON.stringify(data)); } catch (_) {}
      // Then sync to Firestore (cloud — may fail if rules not configured)
      Storage._docRef().set(data).catch(e => {
        console.warn('Firestore save failed (data is safe in local cache):', e.message);
      });
      // Photos → localStorage
      try { localStorage.setItem('weightTrackerPhotos', JSON.stringify(State.photos)); } catch (_) {}
    } catch (e) {
      console.error('Storage.save error:', e);
    }
  },

  /** Export all data as a downloadable JSON file. */
  exportJSON() {
    const payload = {
      profile: State.profile,
      entries: State.entries,
      photos:  State.photos,
      meta: {
        exportedAt: new Date().toISOString(),
        version: APP_VERSION
      }
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `weightloss-backup-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    UI.showToast('Data exported successfully!', 'success');
  },

  /**
   * Import data from a JSON file. Replaces State entirely.
   * @param {File} file
   * @param {Function} [onDone] - callback when import is complete
   */
  importJSON(file, onDone) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        // Basic validation
        if (!data.profile || !Array.isArray(data.entries)) {
          UI.showToast('Invalid file format. Please use a valid export file.', 'error');
          return;
        }
        // Replace state
        State.profile = data.profile  || State.profile;
        State.entries = data.entries  || [];
        State.photos  = Storage._migratePhotos(data.photos || []);
        // Ensure coach object exists
        if (!State.profile.coach) {
          State.profile.coach = { enabled: false, name: '', checkInDay: 'thursday', arrangementNotes: '', questionsForCoach: '' };
        }
        if (State.profile.coach.questionsForCoach === undefined) {
          State.profile.coach.questionsForCoach = '';
        }
        if (!State.profile.coach.weeklyPlan) {
          State.profile.coach.weeklyPlan = {
            monday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
            tuesday:   {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
            wednesday: {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
            thursday:  {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
            friday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
            saturday:  {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
            sunday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''}
          };
        } else {
          Object.keys(State.profile.coach.weeklyPlan).forEach(day => {
            const d = State.profile.coach.weeklyPlan[day];
            if (d.fatTarget   === undefined) d.fatTarget   = null;
            if (d.carbsTarget === undefined) d.carbsTarget = null;
          });
        }
        if (State.profile.travelMode === undefined) State.profile.travelMode = false;
        if (State.profile.maintenanceCalories === undefined) State.profile.maintenanceCalories = null;
        if (State.profile.weeklyGoalKg === undefined) State.profile.weeklyGoalKg = null;
        if (!State.profile.mvdPresets) {
          State.profile.mvdPresets = [
            {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null},
            {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null},
            {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null}
          ];
        }
        // Recalculate all computed fields in case schema changed
        Computed.recalculateAll();
        Storage.save();
        // Mark wizard done so we never show it again after import
        Storage.markWizardDone();
        UI.showToast('Data imported successfully!', 'success');
        if (onDone) onDone();
      } catch (err) {
        UI.showToast('Failed to parse file. Is it a valid JSON export?', 'error');
        console.error('importJSON error:', err);
      }
    };
    reader.readAsText(file);
  },

  /** True if user has never completed the setup wizard (no name = not set up). */
  isFirstLaunch() {
    return !State.profile.name;
  },

  /** No-op: wizard completion is implicit once the profile has a name in Firestore. */
  markWizardDone() {}
};

/* ============================================================
   COMPUTED — auto-calculated fields engine
   All computed fields are derived from State and stored on entries
   so exports are self-contained and charts don't need to re-derive.
   ============================================================ */
const Computed = {
  /**
   * Re-sort entries by date and recalculate all computed fields.
   * Call this after any add/update/delete and after profile height changes.
   */
  recalculateAll() {
    // Sort ascending by date string (ISO sorts correctly lexicographically)
    State.entries.sort((a, b) => a.date.localeCompare(b.date));

    const startingWeight = State.profile.startingWeightKg || 0;
    const heightM = (State.profile.heightCm || 0) / 100;

    State.entries.forEach((entry, idx) => {
      const w = entry.weightKg;

      // kg lost compared to previous entry (can be negative = weight gain)
      if (idx === 0) {
        entry.kgLostFromPrev = 0;
      } else {
        const prev = State.entries[idx - 1];
        entry.kgLostFromPrev = parseFloat((prev.weightKg - w).toFixed(2));
      }

      // Total kg lost since starting weight
      entry.totalKgLost = startingWeight > 0
        ? parseFloat((startingWeight - w).toFixed(2))
        : 0;

      // Total % lost relative to starting weight
      entry.totalPctLost = startingWeight > 0
        ? parseFloat(((entry.totalKgLost / startingWeight) * 100).toFixed(1))
        : 0;

      // BMI = weight(kg) / height(m)^2
      entry.bmi = heightM > 0
        ? parseFloat((w / (heightM * heightM)).toFixed(1))
        : 0;
    });
  },

  /**
   * Calculate computed fields for a weight value in the context of
   * an existing date (for live dashboard form updates, without saving).
   * @param {string} dateStr - ISO date being edited
   * @param {number} weightKg
   * @returns {{ kgFromPrev, totalKgLost, totalPctLost, bmi }}
   */
  forLiveEntry(dateStr, weightKg) {
    const startingWeight = State.profile.startingWeightKg || 0;
    const heightM = (State.profile.heightCm || 0) / 100;

    // Find the most recent entry strictly before this date
    const prev = Entries.getPreviousEntry(dateStr);

    const kgFromPrev = prev
      ? parseFloat((prev.weightKg - weightKg).toFixed(2))
      : null; // null = first entry

    const totalKgLost = startingWeight > 0
      ? parseFloat((startingWeight - weightKg).toFixed(2))
      : null;

    const totalPctLost = (startingWeight > 0 && totalKgLost !== null)
      ? parseFloat(((totalKgLost / startingWeight) * 100).toFixed(1))
      : null;

    const bmi = heightM > 0
      ? parseFloat((weightKg / (heightM * heightM)).toFixed(1))
      : null;

    return { kgFromPrev, totalKgLost, totalPctLost, bmi };
  },

  /**
   * Returns summary statistics for the dashboard cards.
   */
  summaryStats() {
    const sorted = Entries.getSorted();
    if (sorted.length === 0) return null;

    const latest = sorted[sorted.length - 1];
    const startW = State.profile.startingWeightKg || 0;
    const goalW  = State.profile.goalWeightKg || 0;

    // Logging streak: consecutive days ending today or yesterday
    const streak = Computed._calculateStreak(sorted);

    // Steps: find the most recent entry with a step count
    const latestWithSteps = [...sorted].reverse().find(e => e.stepsCount !== null && e.stepsCount !== undefined);
    const latestSteps = latestWithSteps ? latestWithSteps.stepsCount : null;
    const latestStepsKm = latestSteps !== null
      ? parseFloat((latestSteps * 0.000762).toFixed(1))
      : null;

    // Trend weight: last non-null value from 7-day MA
    const trendValues = Computed.calcTrendWeights(sorted);
    const trendWeight = [...trendValues].reverse().find(v => v !== null) ?? null;

    // 7-day average weight loss (kg per week based on last 7 entries)
    let sevenDayAvgLoss = null;
    const last7 = sorted.slice(-7);
    if (last7.length >= 2) {
      const days = UI.dateDiffDays(last7[0].date, last7[last7.length - 1].date);
      const kgLost = last7[0].weightKg - last7[last7.length - 1].weightKg;
      sevenDayAvgLoss = days > 0 ? parseFloat((kgLost / days * 7).toFixed(2)) : null;
    }

    // Points for today's entry
    const todayEntry = sorted.find(e => e.date === UI.todayISO());
    const todayPoints = todayEntry ? Computed.calcPoints(todayEntry) : null;

    return {
      currentWeight:  latest.weightKg,
      totalKgLost:    latest.totalKgLost,
      totalPctLost:   latest.totalPctLost,
      currentBMI:     latest.bmi,
      bmiCategory:    Computed.bmiCategory(latest.bmi),
      goalRemaining:  goalW > 0 ? parseFloat((latest.weightKg - goalW).toFixed(2)) : null,
      streak,
      latestSteps,
      latestStepsKm,
      trendWeight,
      sevenDayAvgLoss,
      todayPoints
    };
  },

  /** Return BMI category label. */
  bmiCategory(bmi) {
    if (!bmi) return '';
    if (bmi < 18.5)  return 'Underweight';
    if (bmi < 25)    return 'Healthy';
    if (bmi < 30)    return 'Overweight';
    if (bmi < 35)    return 'Obese I';
    if (bmi < 40)    return 'Obese II';
    return 'Obese III';
  },

  /**
   * For each entry, compute a 7-day moving average of weight (includes current entry).
   * Returns array of values (null if no weight data in window).
   */
  calcTrendWeights(sortedEntries) {
    return sortedEntries.map((entry, i) => {
      const window = sortedEntries.slice(Math.max(0, i - 6), i + 1).filter(e => e.weightKg);
      if (window.length === 0) return null;
      return parseFloat((window.reduce((s, e) => s + e.weightKg, 0) / window.length).toFixed(2));
    });
  },

  /**
   * Returns plateau info if trend weight hasn't moved > 0.3kg in last 14 data points.
   */
  detectPlateau(sortedEntries) {
    const trends = Computed.calcTrendWeights(sortedEntries);
    const recent = trends.filter(v => v !== null).slice(-14);
    if (recent.length < 14) return null;
    const range = Math.max(...recent) - Math.min(...recent);
    if (range < 0.3) return { rangeKg: range.toFixed(2) };
    return null;
  },

  /**
   * Calculate daily points score for a single entry (max 5 pts).
   * Points: calories under target, protein on/over target, sodium < 2300, steps on/over target, lifting day.
   */
  calcPoints(entry) {
    if (!entry || !entry.weightKg) return 0;
    let points = 0;

    // Get coach targets for this entry's day of week
    let plan = null;
    if (Coach.isEnabled()) {
      const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const [y, m, d] = entry.date.split('-').map(Number);
      plan = State.profile.coach?.weeklyPlan?.[days[new Date(y, m - 1, d).getDay()]];
    }

    // 1. Calories under target
    if (entry.caloriesKcal !== null && plan?.caloriesTarget) {
      if (entry.caloriesKcal <= plan.caloriesTarget) points++;
    }
    // 2. Protein at or above target
    if (entry.proteinG !== null && plan?.proteinTarget) {
      if (entry.proteinG >= plan.proteinTarget) points++;
    }
    // 3. Sodium under 2300 mg
    if (entry.sodiumMg !== null && entry.sodiumMg < 2300) points++;
    // 4. Steps at or above target
    if (entry.stepsCount !== null && plan?.stepsTarget) {
      if (entry.stepsCount >= plan.stepsTarget) points++;
    }
    // 5. Lifting day completed
    if (entry.liftingDay === true) points++;

    return points;
  },

  /**
   * Returns goal timeline data: estimated completion date, days remaining, kg remaining.
   */
  goalTimeline() {
    const sorted = Entries.getSorted();
    if (sorted.length === 0) return null;
    const goalW = State.profile.goalWeightKg;
    if (!goalW) return null;

    const latest = sorted[sorted.length - 1];
    const kgRemaining = parseFloat((latest.weightKg - goalW).toFixed(2));
    if (kgRemaining <= 0) return { reached: true, kgRemaining };

    // Weekly rate: prefer user-set goal, fall back to actual trend
    let weeklyRate = State.profile.weeklyGoalKg || null;
    let actualWeeklyRate = null;
    const recentEntries = sorted.slice(-28);
    if (recentEntries.length >= 2) {
      const days = UI.dateDiffDays(recentEntries[0].date, recentEntries[recentEntries.length - 1].date);
      const kgLost = recentEntries[0].weightKg - recentEntries[recentEntries.length - 1].weightKg;
      if (days > 0) actualWeeklyRate = parseFloat((kgLost / days * 7).toFixed(2));
    }
    if (!weeklyRate) weeklyRate = actualWeeklyRate;
    if (!weeklyRate || weeklyRate <= 0) return { kgRemaining, noRate: true };

    const daysToGoal = Math.round((kgRemaining / weeklyRate) * 7);
    const [ty, tm, td] = UI.todayISO().split('-').map(Number);
    const goalDate = new Date(ty, tm - 1, td + daysToGoal);
    const estimatedDate = `${goalDate.getFullYear()}-${String(goalDate.getMonth()+1).padStart(2,'0')}-${String(goalDate.getDate()).padStart(2,'0')}`;
    return { kgRemaining, daysToGoal, estimatedDate, weeklyRate, actualWeeklyRate };
  },

  /**
   * Returns array of water-retention flag strings based on recent entries.
   */
  waterRetentionFlags(sortedEntries) {
    const withWeight = sortedEntries.filter(e => e.weightKg);
    if (withWeight.length < 2) return [];
    const latest = withWeight[withWeight.length - 1];
    const prev   = withWeight[withWeight.length - 2];
    if (latest.weightKg <= prev.weightKg) return [];
    const flags = [];
    if (prev.sodiumMg !== null && prev.sodiumMg > 3000) flags.push('💧 High sodium yesterday');
    if (prev.sleepHours !== null && prev.sleepHours < 6) flags.push('😴 Poor sleep last night');
    return flags;
  },

  /** Count consecutive days logged ending at today (or most recent entry). */
  _calculateStreak(sortedEntries) {
    if (sortedEntries.length === 0) return 0;
    let streak = 1;
    for (let i = sortedEntries.length - 1; i > 0; i--) {
      const curr = sortedEntries[i].date;
      const prev = sortedEntries[i - 1].date;
      // Calculate difference in days
      const diff = UI.dateDiffDays(prev, curr);
      if (diff === 1) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }
};

/* ============================================================
   UI — shared UI helpers: toasts, modals, formatting
   ============================================================ */
const UI = {
  /**
   * Show a toast notification.
   * @param {string} message
   * @param {'success'|'error'|'warning'|'info'} type
   */
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    // Auto-dismiss after 3.5 seconds
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 350);
    }, 3500);
  },

  showModal(overlayEl) {
    overlayEl.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  },

  hideModal(overlayEl) {
    overlayEl.classList.add('hidden');
    document.body.style.overflow = '';
  },

  /**
   * Format an ISO date string for display.
   * Avoids new Date() timezone bug by parsing manually.
   * @param {string} isoStr — 'YYYY-MM-DD'
   * @returns {string} — '5 Mar 2026'
   */
  formatDate(isoStr) {
    if (!isoStr) return '—';
    const [y, m, d] = isoStr.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun',
                    'Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d} ${months[m - 1]} ${y}`;
  },

  /**
   * Safely format a number with given decimal places.
   * Returns '—' for null/undefined/NaN.
   */
  formatNum(val, decimals = 1) {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return Number(val).toFixed(decimals);
  },

  /** Today's date as ISO string YYYY-MM-DD (local time). */
  todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  /**
   * Number of days between two ISO date strings.
   * @param {string} fromISO
   * @param {string} toISO
   * @returns {number}
   */
  dateDiffDays(fromISO, toISO) {
    const parse = (s) => {
      const [y, m, d] = s.split('-').map(Number);
      return new Date(y, m - 1, d).getTime();
    };
    return Math.round((parse(toISO) - parse(fromISO)) / 86400000);
  },

  /**
   * Calculate age from a DOB ISO string.
   * @param {string} dobISO
   * @returns {number}
   */
  calcAge(dobISO) {
    if (!dobISO) return null;
    const [y, m, d] = dobISO.split('-').map(Number);
    const today = new Date();
    let age = today.getFullYear() - y;
    if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) {
      age--;
    }
    return age;
  },

  /** Get a numeric value from an input, returning null if empty. */
  numOrNull(inputEl) {
    const val = inputEl.value.trim();
    if (val === '' || val === null) return null;
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  },

  /** Set an input value, clearing it if val is null. */
  setInputVal(inputEl, val) {
    inputEl.value = (val !== null && val !== undefined) ? val : '';
  }
};

/* ============================================================
   ENTRIES — CRUD operations on State.entries
   ============================================================ */
const Entries = {
  /** Return a copy of entries sorted ascending by date. */
  getSorted() {
    return [...State.entries].sort((a, b) => a.date.localeCompare(b.date));
  },

  /** Find entry by id (=date string). Returns undefined if not found. */
  getById(id) {
    return State.entries.find(e => e.id === id);
  },

  /** Most recent entry strictly before dateStr. Returns undefined if none. */
  getPreviousEntry(dateStr) {
    const sorted = Entries.getSorted();
    let prev;
    for (const e of sorted) {
      if (e.date < dateStr) prev = e;
      else break;
    }
    return prev;
  },

  /**
   * Add a new entry. If an entry for that date already exists,
   * ask the user to confirm overwrite.
   * @param {object} formData
   * @returns {boolean} true if saved
   */
  add(formData) {
    const existing = Entries.getById(formData.date);
    if (existing) {
      if (!confirm(`An entry for ${UI.formatDate(formData.date)} already exists. Overwrite it?`)) {
        return false;
      }
      // Remove old entry then add fresh
      Entries._removeById(formData.date);
    }
    const entry = Entries._buildEntry(formData);
    State.entries.push(entry);
    Computed.recalculateAll();
    Storage.save();
    return true;
  },

  /**
   * Update an existing entry by id.
   * @param {string} id
   * @param {object} formData
   */
  update(id, formData) {
    const idx = State.entries.findIndex(e => e.id === id);
    if (idx === -1) return;
    State.entries[idx] = Entries._buildEntry(formData);
    Computed.recalculateAll();
    Storage.save();
  },

  /**
   * Delete an entry by id.
   * @param {string} id
   */
  delete(id) {
    Entries._removeById(id);
    Computed.recalculateAll();
    Storage.save();
  },

  /** Build a standardised entry object from raw form data. */
  _buildEntry(data) {
    return {
      id:            data.date,
      date:          data.date,
      weightKg:      parseFloat(data.weightKg),
      caloriesKcal:  data.caloriesKcal !== null ? parseFloat(data.caloriesKcal) : null,
      proteinG:      data.proteinG     !== null ? parseFloat(data.proteinG)     : null,
      carbsG:        data.carbsG       !== null ? parseFloat(data.carbsG)       : null,
      fatG:          data.fatG         !== null ? parseFloat(data.fatG)         : null,
      sodiumMg:      data.sodiumMg     !== null ? parseFloat(data.sodiumMg)     : null,
      waistCm:       data.waistCm      !== null ? parseFloat(data.waistCm)      : null,
      bicepCm:       data.bicepCm      !== null ? parseFloat(data.bicepCm)      : null,
      thighCm:       data.thighCm      !== null ? parseFloat(data.thighCm)      : null,
      nsv:           data.nsv          || '',
      stepsCount:    data.stepsCount   !== null && data.stepsCount !== undefined
                       ? parseInt(data.stepsCount) : null,
      coachNotes:    data.coachNotes   || null,
      sleepHours:    data.sleepHours   !== null && data.sleepHours !== undefined
                       ? parseFloat(data.sleepHours) : null,
      alcoholDrinks: data.alcoholDrinks !== null && data.alcoholDrinks !== undefined
                       ? parseInt(data.alcoholDrinks) : null,
      hungerLevel:   data.hungerLevel  !== null && data.hungerLevel !== undefined
                       ? parseInt(data.hungerLevel) : null,
      energyLevel:   data.energyLevel  !== null && data.energyLevel !== undefined
                       ? parseInt(data.energyLevel) : null,
      adherenceScore: data.adherenceScore || null,
      adherenceWhy:   data.adherenceWhy   || null,
      liftingDay:     data.liftingDay === true ? true : (data.liftingDay === false ? false : null),
      // Computed fields — filled by Computed.recalculateAll()
      kgLostFromPrev: 0,
      totalKgLost:    0,
      totalPctLost:   0,
      bmi:            0
    };
  },

  _removeById(id) {
    const idx = State.entries.findIndex(e => e.id === id);
    if (idx !== -1) State.entries.splice(idx, 1);
  }
};

/* ============================================================
   QUOTES — motivational banner on dashboard
   ============================================================ */
const Quotes = {
  _idx: -1,
  _quotes: [
    { text: "The journey of a thousand miles begins with one step.", author: "Lao Tzu" },
    { text: "Take care of your body. It's the only place you have to live.", author: "Jim Rohn" },
    { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
    { text: "Success is the sum of small efforts, repeated day in and day out.", author: "Robert Collier" },
    { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
    { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius" },
    { text: "Don't watch the scale — watch the habits.", author: "Unknown" },
    { text: "A year from now you'll wish you had started today.", author: "Karen Lamb" },
    { text: "Your body can stand almost anything. It's your mind you have to convince.", author: "Unknown" },
    { text: "Healthy is an outfit that looks different on everybody.", author: "Unknown" },
    { text: "One pound at a time. One day at a time. One meal at a time.", author: "Unknown" },
    { text: "The difference between try and triumph is just a little umph!", author: "Marvin Phillips" },
    { text: "Small daily improvements are the key to staggering long-term results.", author: "Unknown" },
    { text: "Every workout is progress. Every healthy meal is progress. Keep going.", author: "Unknown" },
    { text: "Discipline is choosing between what you want now and what you want most.", author: "Abraham Lincoln" },
    { text: "Rome wasn't built in a day, but they were laying bricks every hour.", author: "John Heywood" },
    { text: "Fall seven times, stand up eight.", author: "Japanese Proverb" },
    { text: "Your future self is watching you right now through your memories.", author: "Aubrey de Grey" },
    { text: "Nothing will work unless you do.", author: "Maya Angelou" },
    { text: "Progress, not perfection.", author: "Unknown" }
  ],

  /** Render a random quote on the dashboard quote banner. */
  render() {
    if (Quotes._idx === -1) {
      // Pick a random quote on first render each session
      Quotes._idx = Math.floor(Math.random() * Quotes._quotes.length);
    }
    Quotes._display();
    // Bind next button (clone to remove stale listeners)
    const btn = document.getElementById('quote-next-btn');
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', Quotes.next);
  },

  next() {
    Quotes._idx = (Quotes._idx + 1) % Quotes._quotes.length;
    Quotes._display();
  },

  _display() {
    const q = Quotes._quotes[Quotes._idx];
    document.getElementById('quote-text').textContent = `"${q.text}"`;
    document.getElementById('quote-attribution').textContent = `— ${q.author}`;
  }
};

/* ============================================================
   COACH — coach check-in logic
   ============================================================ */
const Coach = {
  /** Returns true if coach feature is enabled in profile. */
  isEnabled() {
    return !!(State.profile.coach && State.profile.coach.enabled);
  },

  /** Returns JS day-of-week index (0=Sunday, 1=Monday … 6=Saturday) for check-in day. */
  getCheckInDayIndex() {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const day = (State.profile.coach && State.profile.coach.checkInDay) || 'thursday';
    const idx = days.indexOf(day.toLowerCase());
    return idx === -1 ? 4 : idx; // default Thursday
  },

  /** Returns true if the given ISO date falls on the coach check-in day. */
  isCheckInDay(isoStr) {
    if (!Coach.isEnabled()) return false;
    const [y, m, d] = isoStr.split('-').map(Number);
    return new Date(y, m - 1, d).getDay() === Coach.getCheckInDayIndex();
  },

  /**
   * Returns the ISO date of the most recent check-in day strictly before the given date.
   * Walks backwards up to 7 days.
   */
  getLastCheckInDate(beforeIsoStr) {
    const [y, m, d] = beforeIsoStr.split('-').map(Number);
    const ref = new Date(y, m - 1, d);
    const targetDay = Coach.getCheckInDayIndex();
    // Walk backwards up to 8 days to find the previous occurrence
    for (let i = 1; i <= 8; i++) {
      const check = new Date(ref.getTime() - i * 86400000);
      if (check.getDay() === targetDay) {
        const yy = check.getFullYear();
        const mm = String(check.getMonth() + 1).padStart(2, '0');
        const dd = String(check.getDate()).padStart(2, '0');
        return `${yy}-${mm}-${dd}`;
      }
    }
    return null;
  },

  /**
   * Calculate kg lost between the last check-in date and the latest entry.
   * Returns { kg, lastCheckInDate, lastCheckInEntry } or null.
   */
  kgLostSinceLastCheckIn() {
    const today = UI.todayISO();
    const lastCheckInDate = Coach.getLastCheckInDate(today);
    if (!lastCheckInDate) return null;

    const sorted = Entries.getSorted();
    if (sorted.length === 0) return null;

    // Find the entry at or closest after the last check-in date
    const checkInEntry = sorted.find(e => e.date >= lastCheckInDate);
    const latestEntry = sorted[sorted.length - 1];

    if (!checkInEntry || !latestEntry) return null;
    if (checkInEntry.id === latestEntry.id) return null; // Same entry, no comparison

    const kg = parseFloat((checkInEntry.weightKg - latestEntry.weightKg).toFixed(2));
    const days = UI.dateDiffDays(lastCheckInDate, today);
    return { kg, lastCheckInDate, days };
  },

  /**
   * Returns NSVs recorded since the last check-in date.
   * @returns {Array<{ date, nsv }>}
   */
  nsvSinceLastCheckIn() {
    const today = UI.todayISO();
    const lastCheckInDate = Coach.getLastCheckInDate(today);
    if (!lastCheckInDate) return [];

    return Entries.getSorted()
      .filter(e => e.date > lastCheckInDate && e.nsv && e.nsv.trim())
      .map(e => ({ date: e.date, nsv: e.nsv.trim() }));
  },

  /**
   * Render/update the coach check-in panel and coach notes field on the dashboard.
   * @param {string} forDate — ISO date of the entry being logged
   */
  renderCheckInPanel(forDate) {
    const panel = document.getElementById('coach-checkin-panel');
    const notesWrap = document.getElementById('entry-coach-notes-wrap');
    const notesLabel = document.getElementById('entry-coach-notes-label');

    if (!Coach.isEnabled() || !Coach.isCheckInDay(forDate)) {
      panel.classList.add('hidden');
      notesWrap.classList.add('hidden');
      notesWrap.classList.remove('checkin-day');
      return;
    }

    const coachName = State.profile.coach.name || 'your coach';

    // Show and populate check-in panel
    panel.classList.remove('hidden');
    document.getElementById('coach-checkin-title').textContent =
      `Today is your check-in day with ${coachName}!`;

    // kg lost since last check-in
    const lostData = Coach.kgLostSinceLastCheckIn();
    document.getElementById('coach-stat-kg-lost').textContent =
      lostData ? UI.formatNum(lostData.kg, 2) : '—';
    document.getElementById('coach-stat-days').textContent =
      lostData ? lostData.days : '—';

    // NSV summary
    const nsvs = Coach.nsvSinceLastCheckIn();
    const nsvList = document.getElementById('coach-nsv-list');
    const nsvEmpty = document.getElementById('coach-nsv-empty');
    nsvList.innerHTML = '';
    if (nsvs.length === 0) {
      nsvEmpty.classList.remove('hidden');
    } else {
      nsvEmpty.classList.add('hidden');
      nsvs.forEach(({ date, nsv }) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="coach-nsv-date">${UI.formatDate(date)}</span> ${nsv}`;
        nsvList.appendChild(li);
      });
    }

    // Show coach notes field (highlighted)
    notesWrap.classList.remove('hidden');
    notesWrap.classList.add('checkin-day');
    if (notesLabel) {
      notesLabel.textContent = `Notes from today's session with ${coachName}`;
    }
  },

  /** Show or hide the Coach nav tab based on whether coach is enabled. */
  updateNavVisibility() {
    const show = Coach.isEnabled();
    const btn = document.getElementById('nav-coach-btn');
    const drawerBtn = document.getElementById('nav-drawer-coach-btn');
    if (btn) btn.classList.toggle('hidden', !show);
    if (drawerBtn) drawerBtn.classList.toggle('hidden', !show);
  }
};

/* ============================================================
   NAV — SPA navigation between pages
   ============================================================ */
const Nav = {
  /** Map page name → render function */
  _pageRenderers: {
    dashboard: () => Dashboard.render(),
    entry:     () => Entry.render(),
    history:   () => History.render(),
    graphs:    () => Charts.render(),
    profile:   () => Profile.render(),
    photos:    () => Photos.render(),
    coach:     () => CoachPage.render()
  },

  init() {
    // Top nav buttons
    document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        Nav.goTo(btn.dataset.page);
        // Close mobile drawer if open
        document.getElementById('nav-drawer').classList.add('hidden');
      });
    });

    // Mobile drawer buttons
    document.querySelectorAll('.nav-drawer-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        Nav.goTo(btn.dataset.page);
        document.getElementById('nav-drawer').classList.add('hidden');
      });
    });

    // Hamburger toggle
    document.getElementById('nav-hamburger').addEventListener('click', () => {
      document.getElementById('nav-drawer').classList.toggle('hidden');
    });

    // Export buttons
    document.getElementById('btn-export-nav').addEventListener('click', () => Storage.exportJSON());
    const exportDrawer = document.getElementById('btn-export-drawer');
    if (exportDrawer) exportDrawer.addEventListener('click', () => Storage.exportJSON());

    // Import buttons (nav)
    const importNav = document.getElementById('btn-import-nav');
    const importNavFile = document.getElementById('nav-import-file-input');
    importNav.addEventListener('click', () => importNavFile.click());
    importNavFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        Storage.importJSON(file, () => Nav.goTo(Nav._currentPage || 'dashboard'));
        importNavFile.value = '';
      }
    });

    // Import drawer
    const importDrawer = document.getElementById('btn-import-drawer');
    if (importDrawer) {
      importDrawer.addEventListener('click', () => importNavFile.click());
    }
  },

  _currentPage: 'dashboard',

  /** Navigate to a page by name. */
  goTo(pageName) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    // Show target page
    const target = document.getElementById(`page-${pageName}`);
    if (target) target.classList.remove('hidden');
    // Update active nav button
    document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === pageName);
    });
    Nav._currentPage = pageName;
    // Call the page's render function
    if (Nav._pageRenderers[pageName]) {
      Nav._pageRenderers[pageName]();
    }
    // Scroll to top
    window.scrollTo(0, 0);
  }
};

/* ============================================================
   WIZARD — first-launch setup wizard
   ============================================================ */
const Wizard = {
  _step: 1,

  show() {
    const overlay = document.getElementById('wizard-overlay');
    overlay.classList.remove('hidden');
    Wizard.goToStep(1);

    // Set default dates
    const today = UI.todayISO();
    const startInput = document.getElementById('wiz-start-date');
    if (!startInput.value) startInput.value = today;

    // Wire up wizard import file input
    const fileInput = document.getElementById('wizard-import-file-input');
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        Storage.importJSON(file, () => {
          document.getElementById('wizard-overlay').classList.add('hidden');
          App.start();
        });
        fileInput.value = '';
      }
    });
  },

  goToStep(n) {
    // Hide all steps
    document.querySelectorAll('.wizard-step').forEach(s => s.classList.add('hidden'));
    // Show target step
    const step = document.getElementById(`wizard-step-${n}`);
    if (step) step.classList.remove('hidden');
    // Update progress dots
    document.querySelectorAll('.wizard-step-dot').forEach(dot => {
      dot.classList.toggle('active', parseInt(dot.dataset.step) <= n);
    });
    Wizard._step = n;
    // Build summary on step 3
    if (n === 3) Wizard._buildSummary();
  },

  nextStep(currentStep) {
    const errors = Wizard._validate(currentStep);
    if (errors.length > 0) {
      UI.showToast(errors[0], 'error');
      return;
    }
    Wizard.goToStep(currentStep + 1);
  },

  _validate(step) {
    const errors = [];
    if (step === 1) {
      if (!document.getElementById('wiz-name').value.trim())    errors.push('Please enter your name.');
      if (!document.getElementById('wiz-dob').value)            errors.push('Please enter your date of birth.');
      const h = parseFloat(document.getElementById('wiz-height').value);
      if (!h || h < 100 || h > 250)                             errors.push('Please enter a valid height (100–250 cm).');
    }
    if (step === 2) {
      if (!document.getElementById('wiz-start-date').value)     errors.push('Please enter your journey start date.');
      const sw = parseFloat(document.getElementById('wiz-starting-weight').value);
      if (!sw || sw < 30 || sw > 400)                           errors.push('Please enter a valid starting weight (30–400 kg).');
      const gw = parseFloat(document.getElementById('wiz-goal-weight').value);
      if (!gw || gw < 30 || gw > 400)                           errors.push('Please enter a valid goal weight (30–400 kg).');
      if (gw && sw && gw >= sw)                                  errors.push('Goal weight should be less than starting weight.');
    }
    return errors;
  },

  _buildSummary() {
    const heightCm = parseFloat(document.getElementById('wiz-height').value);
    const startW   = parseFloat(document.getElementById('wiz-starting-weight').value);
    const goalW    = parseFloat(document.getElementById('wiz-goal-weight').value);
    const heightM  = heightCm / 100;
    const bmi      = heightM > 0 ? (startW / (heightM * heightM)).toFixed(1) : '—';
    const tolose   = (startW - goalW).toFixed(1);

    document.getElementById('wizard-summary').innerHTML = `
      <div><strong>Name:</strong> ${document.getElementById('wiz-name').value}</div>
      <div><strong>Date of Birth:</strong> ${UI.formatDate(document.getElementById('wiz-dob').value)}</div>
      <div><strong>Height:</strong> ${heightCm} cm</div>
      <div><strong>Start Date:</strong> ${UI.formatDate(document.getElementById('wiz-start-date').value)}</div>
      <div><strong>Starting Weight:</strong> ${startW} kg (BMI ${bmi})</div>
      <div><strong>Goal Weight:</strong> ${goalW} kg (${tolose} kg to lose)</div>
    `;
  },

  handleComplete() {
    // Collect data
    State.profile = {
      name:              document.getElementById('wiz-name').value.trim(),
      dob:               document.getElementById('wiz-dob').value,
      heightCm:          parseFloat(document.getElementById('wiz-height').value),
      startingWeightKg:  parseFloat(document.getElementById('wiz-starting-weight').value),
      goalWeightKg:      parseFloat(document.getElementById('wiz-goal-weight').value),
      journeyStartDate:  document.getElementById('wiz-start-date').value,
      coach: {
        enabled: false, name: '', checkInDay: 'thursday', arrangementNotes: '', questionsForCoach: '',
        weeklyPlan: {
          monday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          tuesday:   {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          wednesday: {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          thursday:  {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          friday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          saturday:  {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          sunday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''}
        }
      },
      travelMode: false,
      maintenanceCalories: null,
      mvdPresets: [
        {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null},
        {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null},
        {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null}
      ]
    };

    // Create an initial entry for the start date with starting weight
    const startDate = State.profile.journeyStartDate;
    if (startDate && !Entries.getById(startDate)) {
      State.entries.push({
        id: startDate, date: startDate,
        weightKg: State.profile.startingWeightKg,
        caloriesKcal: null, proteinG: null, carbsG: null, fatG: null, sodiumMg: null,
        waistCm: null, bicepCm: null, thighCm: null, nsv: 'Journey begins!',
        stepsCount: null, coachNotes: null,
        sleepHours: null, alcoholDrinks: null, hungerLevel: null, energyLevel: null,
        adherenceScore: null, adherenceWhy: null,
        kgLostFromPrev: 0, totalKgLost: 0, totalPctLost: 0, bmi: 0
      });
    }

    Computed.recalculateAll();
    Storage.save();
    Storage.markWizardDone();

    document.getElementById('wizard-overlay').classList.add('hidden');
    App.start();
  },

  /** User clicked "Import it instead" — trigger file picker */
  importInstead() {
    document.getElementById('wizard-import-file-input').click();
  }
};

/* ============================================================
   IMPORT PROMPT — returning-user import dialog
   ============================================================ */
const ImportPrompt = {
  show() {
    const overlay = document.getElementById('import-prompt-overlay');
    UI.showModal(overlay);

    const fileInput = document.getElementById('import-file-input');
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        Storage.importJSON(file, () => {
          UI.hideModal(overlay);
          App.start();
        });
        fileInput.value = '';
      }
    }, { once: true });
  },

  chooseFile() {
    document.getElementById('import-file-input').click();
  },

  skipImport() {
    UI.hideModal(document.getElementById('import-prompt-overlay'));
    App.start();
  }
};

/* ============================================================
   DASHBOARD — summary page (stats, mini charts, progress bar)
   ============================================================ */
const Dashboard = {
  render() {
    const today = UI.todayISO();
    Dashboard._renderTargetBanner();
    Quotes.render();
    Dashboard._checkMissingDays();
    Dashboard._checkPlateau();
    Coach.renderCheckInPanel(today);
    Dashboard._updateSummaryCards();
    Dashboard._renderProgressBar();
    Dashboard._renderGoalTimeline();
    Dashboard._renderMiniCharts();
    Dashboard._renderLogCTA();
  },

  /** Check for days since journey start that have no weigh-in and display alert. */
  _checkMissingDays() {
    const alert  = document.getElementById('missing-days-alert');
    const list   = document.getElementById('missing-days-list');
    const startDate = State.profile.journeyStartDate;
    if (!startDate) { alert.classList.add('hidden'); return; }

    const today     = UI.todayISO();
    const yesterday = (() => {
      const [y, m, d] = today.split('-').map(Number);
      const dt = new Date(y, m - 1, d - 1);
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    })();

    if (startDate > yesterday) { alert.classList.add('hidden'); return; }

    // Build set of dates that have a weight entry
    const datesWithWeight = new Set(
      State.entries.filter(e => e.weightKg).map(e => e.date)
    );

    // Walk from startDate to yesterday, collect missing
    const missing = [];
    let current = startDate;
    while (current <= yesterday) {
      if (!datesWithWeight.has(current)) missing.push(current);
      const [y, m, d] = current.split('-').map(Number);
      const next = new Date(y, m - 1, d + 1);
      current = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}`;
    }

    if (missing.length === 0) {
      // Still check nudges even if no missing days
      alert.classList.remove('hidden');
      list.innerHTML = '';
    } else {
      // Show the 10 most recent missing dates
      alert.classList.remove('hidden');
      list.innerHTML = '';
      missing.slice(-10).reverse().forEach(date => {
        const badge = document.createElement('button');
        badge.className = 'missing-day-badge';
        badge.textContent = UI.formatDate(date);
        badge.title = `Click to log entry for ${UI.formatDate(date)}`;
        badge.addEventListener('click', () => {
          // Navigate to entry page with that date pre-filled
          Nav.goTo('entry');
          setTimeout(() => {
            const dateEl = document.getElementById('entry-date');
            if (dateEl) {
              dateEl.value = date;
              dateEl.dispatchEvent(new Event('change'));
              document.getElementById('page-entry')?.scrollIntoView({ behavior: 'smooth' });
            }
          }, 50);
        });
        list.appendChild(badge);
      });
    }

    // Time-aware nudges
    const nudgesEl = document.getElementById('data-nudges');
    if (nudgesEl) {
      nudgesEl.innerHTML = '';
      const hour = new Date().getHours();
      const todayEntry = Entries.getById(today);
      const nudges = [];
      if (hour >= 10 && !todayEntry) nudges.push("Time for your morning weigh-in!");
      if (hour >= 20 && todayEntry && todayEntry.caloriesKcal === null) nudges.push("Log today's calories before bed");
      nudges.forEach(msg => {
        const el = document.createElement('span');
        el.className = 'nudge-badge';
        el.textContent = msg;
        nudgesEl.appendChild(el);
      });
    }

    // Hide the whole alert if nothing to show
    if (missing.length === 0 && nudgesEl && nudgesEl.children.length === 0) {
      alert.classList.add('hidden');
    }
  },

  _renderTargetBanner() {
    const p = State.profile;
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const todayDay = days[new Date().getDay()];
    const plan = p.coach?.weeklyPlan?.[todayDay];
    const travelMode = p.travelMode;
    const banner = document.getElementById('today-target-banner');
    if (!banner) return;

    const hasPlan = plan && (plan.caloriesTarget || plan.proteinTarget || plan.fatTarget || plan.carbsTarget || plan.stepsTarget || plan.training);
    if (!hasPlan && !travelMode) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    const calories = travelMode ? (p.maintenanceCalories || '—') : (plan?.caloriesTarget || '—');
    const protein  = travelMode ? '—' : (plan?.proteinTarget || '—');
    const fat      = travelMode ? '—' : (plan?.fatTarget || '—');
    const carbs    = travelMode ? '—' : (plan?.carbsTarget || '—');
    const steps    = travelMode ? '—' : (plan?.stepsTarget || '—');
    const training = travelMode ? 'Maintenance mode' : (plan?.training || '—');

    document.getElementById('target-day-label').textContent =
      todayDay.charAt(0).toUpperCase() + todayDay.slice(1);
    document.getElementById('target-travel-badge').classList.toggle('hidden', !travelMode);
    set('target-calories', calories !== '—' ? Number(calories).toLocaleString() + ' kcal' : '—');
    set('target-protein',  protein  !== '—' ? protein + 'g' : '—');
    set('target-fat',      fat      !== '—' ? fat      + 'g' : '—');
    set('target-carbs',    carbs    !== '—' ? carbs    + 'g' : '—');
    set('target-steps',    steps    !== '—' ? Number(steps).toLocaleString() : '—');
    set('target-training', training);

    // MVD preset buttons
    const mvdBtns = document.getElementById('target-mvd-btns');
    const mvdRow  = document.getElementById('target-mvd-row');
    if (mvdBtns) {
      mvdBtns.innerHTML = '';
      (p.mvdPresets || []).forEach((preset, i) => {
        if (!preset.name) return;
        const btn = document.createElement('button');
        btn.className = 'mvd-preset-btn';
        btn.textContent = preset.name;
        btn.addEventListener('click', () => Dashboard._applyMVDPreset(i));
        mvdBtns.appendChild(btn);
      });
      if (mvdRow) mvdRow.classList.toggle('hidden', mvdBtns.children.length === 0);
    }
  },

  _applyMVDPreset(i) {
    const preset = (State.profile.mvdPresets || [])[i];
    if (!preset) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('target-calories', preset.caloriesTarget ? Number(preset.caloriesTarget).toLocaleString() + ' kcal' : '—');
    set('target-protein',  preset.proteinTarget  ? preset.proteinTarget + 'g' : '—');
    set('target-steps',    preset.stepsTarget    ? Number(preset.stepsTarget).toLocaleString() : '—');
    set('target-training', '(MVD preset)');
    // Highlight active preset button
    document.querySelectorAll('.mvd-preset-btn').forEach((btn, idx) => {
      btn.classList.toggle('active', idx === i);
    });
  },

  _checkPlateau() {
    const alert = document.getElementById('plateau-alert');
    if (!alert) return;
    const sorted = Entries.getSorted();
    const plateau = Computed.detectPlateau(sorted);
    alert.classList.toggle('hidden', !plateau);
    if (plateau) {
      const body = document.getElementById('plateau-alert-body');
      if (body) {
        body.innerHTML = `Your 7-day trend weight has not decreased meaningfully in 14 days (range: ${plateau.rangeKg} kg).<br>
          <strong>Suggestions:</strong>
          <ul class="plateau-suggestions">
            <li>Reduce calories by 150 kcal/day</li>
            <li>Add 3,000 steps to your daily target</li>
            <li>Ensure protein is at or above your target</li>
            <li>Discuss a diet break or refeed with your coach</li>
          </ul>`;
      }
    }
  },

  _renderGoalTimeline() {
    const section = document.getElementById('goal-timeline-section');
    if (!section) return;
    const timeline = Computed.goalTimeline();
    if (!timeline || timeline.noRate) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    if (timeline.reached) {
      set('goal-timeline-rate', 'Goal reached!');
      set('goal-est-date', 'Achieved!');
      set('goal-days-remaining', '0');
      set('goal-kg-remaining', '0');
      return;
    }
    set('goal-timeline-rate', `At ${UI.formatNum(timeline.weeklyRate, 2)} kg/week`);
    set('goal-est-date', UI.formatDate(timeline.estimatedDate));
    set('goal-days-remaining', timeline.daysToGoal.toLocaleString());
    set('goal-kg-remaining', UI.formatNum(timeline.kgRemaining, 1));
  },

  _renderRetentionFlags() {
    const el = document.getElementById('retention-flags');
    if (!el) return;
    const sorted = Entries.getSorted();
    const flags = Computed.waterRetentionFlags(sorted);
    if (flags.length === 0) {
      el.classList.add('hidden');
      el.innerHTML = '';
    } else {
      el.classList.remove('hidden');
      el.innerHTML = flags.map(f => `<span class="retention-flag-pill">${f}</span>`).join('');
    }
  },

  _updateSummaryCards() {
    const stats = Computed.summaryStats();

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    if (!stats) {
      set('stat-current-weight', '—');
      set('stat-total-lost', '—');
      set('stat-pct-lost', '—');
      set('stat-bmi', '—');
      set('stat-bmi-category', '');
      set('stat-goal-remaining', '—');
      set('stat-streak', '—');
      set('stat-steps', '—');
      set('stat-steps-km', '');
      set('stat-7day-avg', '—');
      set('stat-today-points', '—');
      return;
    }

    set('stat-current-weight', UI.formatNum(stats.currentWeight, 1));
    set('stat-total-lost',     UI.formatNum(stats.totalKgLost, 1));
    set('stat-pct-lost',       UI.formatNum(stats.totalPctLost, 1));
    set('stat-bmi',            UI.formatNum(stats.currentBMI, 1));
    set('stat-bmi-category',   stats.bmiCategory);
    set('stat-goal-remaining',
      stats.goalRemaining !== null
        ? (stats.goalRemaining <= 0 ? 'Goal reached!' : UI.formatNum(stats.goalRemaining, 1))
        : '—');
    set('stat-streak', stats.streak);
    set('stat-steps',
      stats.latestSteps !== null ? stats.latestSteps.toLocaleString() : '—');
    set('stat-steps-km',
      stats.latestStepsKm !== null ? `≈ ${stats.latestStepsKm} km` : '');
    set('stat-trend-weight',
      stats.trendWeight !== null ? UI.formatNum(stats.trendWeight, 1) : '—');
    set('stat-7day-avg',
      stats.sevenDayAvgLoss !== null ? UI.formatNum(stats.sevenDayAvgLoss, 2) : '—');
    set('stat-today-points',
      stats.todayPoints !== null ? `${stats.todayPoints} / 5` : '—');

    Dashboard._renderRetentionFlags();
  },

  _renderProgressBar() {
    const section = document.getElementById('summary-progress-section');
    if (!section) return;
    const startW = State.profile.startingWeightKg;
    const goalW  = State.profile.goalWeightKg;
    const sorted = Entries.getSorted();
    if (!startW || !goalW || sorted.length === 0) {
      section.classList.add('hidden');
      return;
    }
    const currentW = sorted[sorted.length - 1].weightKg;
    const totalToLose = startW - goalW;
    const lostSoFar  = startW - currentW;
    const pct = totalToLose > 0
      ? Math.min(100, Math.max(0, (lostSoFar / totalToLose) * 100))
      : 0;

    section.classList.remove('hidden');
    const fill = document.getElementById('summary-progress-bar-fill');
    const pctEl = document.getElementById('summary-progress-pct');
    const startEl = document.getElementById('summary-progress-start');
    const goalEl  = document.getElementById('summary-progress-goal');
    if (fill)  fill.style.width = pct.toFixed(1) + '%';
    if (pctEl) pctEl.textContent = pct.toFixed(1) + '% complete';
    if (startEl) startEl.textContent = `Start: ${startW} kg`;
    if (goalEl)  goalEl.textContent  = `Goal: ${goalW} kg`;
  },

  _renderMiniCharts() {
    // Destroy existing mini charts
    ['miniWeight', 'miniSteps'].forEach(k => {
      if (State.charts[k]) { State.charts[k].destroy(); State.charts[k] = null; }
    });

    const allEntries = Entries.getSorted();
    const last30 = allEntries.filter(e => UI.dateDiffDays(e.date, UI.todayISO()) <= 30);

    // Mini weight chart
    const weightCanvas = document.getElementById('chart-mini-weight');
    if (weightCanvas && last30.length > 0) {
      const labels = last30.map(e => UI.formatDate(e.date));
      const trendVals = Computed.calcTrendWeights(last30);
      State.charts.miniWeight = new Chart(weightCanvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Weight (kg)',
              data: last30.map(e => e.weightKg),
              borderColor: '#60a5fa',
              backgroundColor: 'rgba(96,165,250,0.08)',
              borderWidth: 2,
              pointRadius: 2,
              tension: 0.3,
              fill: true,
              spanGaps: false
            },
            {
              label: '7-day trend',
              data: trendVals,
              borderColor: '#a78bfa',
              borderWidth: 1.5,
              borderDash: [5, 3],
              pointRadius: 0,
              fill: false,
              spanGaps: true,
              tension: 0.3
            }
          ]
        },
        options: Charts._miniConfig('kg')
      });
    }

    // Mini steps chart
    const stepsCanvas = document.getElementById('chart-mini-steps');
    if (stepsCanvas && last30.length > 0) {
      const stepsData = last30.map(e => e.stepsCount !== null && e.stepsCount !== undefined ? e.stepsCount : null);
      const labels = last30.map(e => UI.formatDate(e.date));
      const trendLine = Charts._calcLinearRegression(stepsData);
      State.charts.miniSteps = new Chart(stepsCanvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Steps',
              data: stepsData,
              backgroundColor: 'rgba(74,222,128,0.5)',
              borderColor: '#4ade80',
              borderWidth: 1,
              borderRadius: 3
            },
            {
              label: 'Trend',
              data: trendLine,
              type: 'line',
              borderColor: '#fbbf24',
              borderWidth: 2,
              borderDash: [5, 3],
              pointRadius: 0,
              fill: false,
              spanGaps: true,
              tension: 0
            }
          ]
        },
        options: Charts._miniConfig('steps')
      });
    }
  },

  _renderLogCTA() {
    const cta = document.getElementById('summary-log-cta');
    const txt = document.getElementById('summary-log-cta-text');
    if (!cta || !txt) return;
    const today = UI.todayISO();
    const existing = Entries.getById(today);
    if (existing) {
      txt.textContent = "Today's entry is logged.";
      cta.classList.remove('hidden');
    } else {
      txt.textContent = "You haven't logged today yet.";
      cta.classList.remove('hidden');
    }
  }
};

/* ============================================================
   HISTORY — entry table with add/edit/delete
   ============================================================ */
const History = {
  render() {
    const sorted = Entries.getSorted().reverse(); // newest first
    History._buildTable(sorted);

    // Add entry button
    const addBtn = document.getElementById('history-add-btn');
    const newAddBtn = addBtn.cloneNode(true);
    addBtn.parentNode.replaceChild(newAddBtn, addBtn);
    newAddBtn.addEventListener('click', () => History.openAddModal());

    // Search
    const searchInput = document.getElementById('history-search');
    const newSearch = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newSearch, searchInput);
    newSearch.value = '';
    newSearch.addEventListener('input', () => {
      const q = newSearch.value.toLowerCase();
      const filtered = sorted.filter(e =>
        e.date.includes(q) || (e.nsv && e.nsv.toLowerCase().includes(q))
      );
      History._buildTable(filtered);
    });

    // Modal close button
    document.getElementById('edit-modal-close').onclick = () => {
      UI.hideModal(document.getElementById('edit-modal-overlay'));
    };
    // Click outside modal to close
    document.getElementById('edit-modal-overlay').onclick = (e) => {
      if (e.target === document.getElementById('edit-modal-overlay')) {
        UI.hideModal(document.getElementById('edit-modal-overlay'));
      }
    };
  },

  _buildTable(entries) {
    const tbody = document.getElementById('history-tbody');
    const empty = document.getElementById('history-empty');
    tbody.innerHTML = '';

    if (entries.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    entries.forEach(e => {
      const tr = document.createElement('tr');
      const kgClass  = e.kgLostFromPrev < 0 ? 'table-computed negative' : 'table-computed';
      const totClass = e.totalKgLost    < 0 ? 'table-computed negative' : 'table-computed';
      // Highlight rows missing a weight entry
      if (!e.weightKg) tr.classList.add('history-row-missing-weight');
      const stepsStr = e.stepsCount !== null && e.stepsCount !== undefined
        ? e.stepsCount.toLocaleString() : '—';
      const coachStr = e.coachNotes ? e.coachNotes.substring(0, 40) + (e.coachNotes.length > 40 ? '…' : '') : '—';
      const adherenceLabel = { on_plan: '✓ On Plan', close: '~ Close', off_plan: '✗ Off Plan' };
      tr.innerHTML = `
        <td>${UI.formatDate(e.date)}</td>
        <td>${UI.formatNum(e.weightKg, 1)}</td>
        <td class="${kgClass}">${UI.formatNum(e.kgLostFromPrev, 2)}</td>
        <td class="${totClass}">${UI.formatNum(e.totalKgLost, 2)}</td>
        <td class="table-computed">${UI.formatNum(e.totalPctLost, 1)}%</td>
        <td class="table-computed">${UI.formatNum(e.bmi, 1)}</td>
        <td>${e.caloriesKcal !== null ? e.caloriesKcal : '—'}</td>
        <td>${e.proteinG !== null ? e.proteinG : '—'}</td>
        <td>${e.carbsG   !== null ? e.carbsG   : '—'}</td>
        <td>${e.fatG     !== null ? e.fatG     : '—'}</td>
        <td>${e.sodiumMg !== null ? e.sodiumMg : '—'}</td>
        <td>${e.waistCm  !== null ? e.waistCm  : '—'}</td>
        <td>${e.bicepCm  !== null ? e.bicepCm  : '—'}</td>
        <td>${e.thighCm  !== null ? e.thighCm  : '—'}</td>
        <td>${stepsStr}</td>
        <td>${e.sleepHours    !== null && e.sleepHours    !== undefined ? e.sleepHours    : '—'}</td>
        <td>${e.alcoholDrinks !== null && e.alcoholDrinks !== undefined ? e.alcoholDrinks : '—'}</td>
        <td>${e.hungerLevel   !== null && e.hungerLevel   !== undefined ? e.hungerLevel   : '—'}</td>
        <td>${e.energyLevel   !== null && e.energyLevel   !== undefined ? e.energyLevel   : '—'}</td>
        <td>${e.adherenceScore ? (adherenceLabel[e.adherenceScore] || e.adherenceScore) : '—'}</td>
        <td class="table-nsv-cell" title="${e.nsv || ''}">${e.nsv || '—'}</td>
        <td class="table-nsv-cell" title="${e.coachNotes || ''}">${coachStr}</td>
        <td>
          <div class="table-actions">
            <button class="btn-table-edit" data-id="${e.id}">Edit</button>
            <button class="btn-table-delete" data-id="${e.id}">Del</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Bind edit/delete buttons
    tbody.querySelectorAll('.btn-table-edit').forEach(btn => {
      btn.addEventListener('click', () => History.openEditModal(btn.dataset.id));
    });
    tbody.querySelectorAll('.btn-table-delete').forEach(btn => {
      btn.addEventListener('click', () => History.confirmDelete(btn.dataset.id));
    });
  },

  openEditModal(id) {
    const entry = Entries.getById(id);
    if (!entry) return;
    document.getElementById('edit-modal-title').textContent = `Edit Entry — ${UI.formatDate(entry.date)}`;
    document.getElementById('edit-entry-id').value    = entry.id;
    document.getElementById('edit-date').value        = entry.date;
    UI.setInputVal(document.getElementById('edit-weight'),   entry.weightKg);
    UI.setInputVal(document.getElementById('edit-calories'), entry.caloriesKcal);
    UI.setInputVal(document.getElementById('edit-protein'),  entry.proteinG);
    UI.setInputVal(document.getElementById('edit-carbs'),    entry.carbsG);
    UI.setInputVal(document.getElementById('edit-fat'),      entry.fatG);
    UI.setInputVal(document.getElementById('edit-sodium'),   entry.sodiumMg);
    UI.setInputVal(document.getElementById('edit-waist'),    entry.waistCm);
    UI.setInputVal(document.getElementById('edit-bicep'),    entry.bicepCm);
    UI.setInputVal(document.getElementById('edit-thigh'),    entry.thighCm);
    UI.setInputVal(document.getElementById('edit-nsv'),      entry.nsv);
    UI.setInputVal(document.getElementById('edit-steps'),    entry.stepsCount);
    UI.setInputVal(document.getElementById('edit-coach-notes'), entry.coachNotes || '');
    UI.setInputVal(document.getElementById('edit-sleep'),    entry.sleepHours);
    UI.setInputVal(document.getElementById('edit-alcohol'),  entry.alcoholDrinks);
    // Edit modal sliders
    const eHunger = document.getElementById('edit-hunger');
    const eEnergy = document.getElementById('edit-energy');
    const eHungerVal = document.getElementById('edit-hunger-val');
    const eEnergyVal = document.getElementById('edit-energy-val');
    if (entry.hungerLevel !== null && entry.hungerLevel !== undefined) {
      if (eHunger) { eHunger.value = entry.hungerLevel; eHunger.dataset.active = '1'; }
      if (eHungerVal) eHungerVal.textContent = entry.hungerLevel;
    } else {
      if (eHunger) { eHunger.value = 5; eHunger.dataset.active = '0'; }
      if (eHungerVal) eHungerVal.textContent = '—';
    }
    if (entry.energyLevel !== null && entry.energyLevel !== undefined) {
      if (eEnergy) { eEnergy.value = entry.energyLevel; eEnergy.dataset.active = '1'; }
      if (eEnergyVal) eEnergyVal.textContent = entry.energyLevel;
    } else {
      if (eEnergy) { eEnergy.value = 5; eEnergy.dataset.active = '0'; }
      if (eEnergyVal) eEnergyVal.textContent = '—';
    }
    // Bind edit modal sliders live display
    if (eHunger) eHunger.addEventListener('input', () => { if (eHungerVal) eHungerVal.textContent = eHunger.value; eHunger.dataset.active = '1'; });
    if (eEnergy) eEnergy.addEventListener('input', () => { if (eEnergyVal) eEnergyVal.textContent = eEnergy.value; eEnergy.dataset.active = '1'; });
    // Edit modal adherence
    const eScoreHidden = document.getElementById('edit-adherence-score');
    const eWhyHidden   = document.getElementById('edit-adherence-why');
    if (eScoreHidden) eScoreHidden.value = entry.adherenceScore || '';
    if (eWhyHidden)   eWhyHidden.value   = entry.adherenceWhy   || '';
    document.querySelectorAll('#edit-adherence-btns .adherence-btn').forEach(btn => {
      btn.className = 'adherence-btn';
      if (entry.adherenceScore && btn.dataset.score === entry.adherenceScore) {
        btn.classList.add('active-' + Entry._adherenceClass(entry.adherenceScore));
      }
    });
    const eWhyRow = document.getElementById('edit-adherence-why-row');
    if (eWhyRow) eWhyRow.classList.toggle('hidden', !entry.adherenceScore || entry.adherenceScore === 'on_plan');
    document.querySelectorAll('#edit-adherence-tags .adherence-tag').forEach(tag => {
      tag.classList.toggle('active', tag.dataset.why === entry.adherenceWhy);
    });
    Entry._bindAdherenceBtns(
      document.querySelectorAll('#edit-adherence-btns .adherence-btn'),
      document.querySelectorAll('#edit-adherence-tags .adherence-tag'),
      document.getElementById('edit-adherence-why-row'),
      document.getElementById('edit-adherence-score'),
      document.getElementById('edit-adherence-why')
    );
    // Show/hide coach notes section based on profile setting
    const coachSection = document.getElementById('edit-coach-notes-section');
    if (coachSection) {
      coachSection.classList.toggle('hidden', !Coach.isEnabled());
    }

    History._bindModalActions(false);
    UI.showModal(document.getElementById('edit-modal-overlay'));
  },

  openAddModal() {
    document.getElementById('edit-modal-title').textContent = 'Add Entry';
    document.getElementById('edit-entry-id').value = '';
    document.getElementById('edit-entry-form').reset();
    document.getElementById('edit-date').value = UI.todayISO();
    History._bindModalActions(true);
    UI.showModal(document.getElementById('edit-modal-overlay'));
  },

  _bindModalActions(isAdd) {
    // Delete button
    const deleteBtn = document.getElementById('edit-delete-btn');
    const newDelete = deleteBtn.cloneNode(true);
    deleteBtn.parentNode.replaceChild(newDelete, deleteBtn);
    if (isAdd) {
      newDelete.style.display = 'none';
    } else {
      newDelete.style.display = '';
      newDelete.addEventListener('click', () => {
        const id = document.getElementById('edit-entry-id').value;
        History.confirmDelete(id, true);
      });
    }

    // Form submit
    const form = document.getElementById('edit-entry-form');
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);
    document.getElementById('edit-modal-close').onclick = () => {
      UI.hideModal(document.getElementById('edit-modal-overlay'));
    };
    document.getElementById('edit-entry-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const dateEl   = document.getElementById('edit-date');
      const weightEl = document.getElementById('edit-weight');
      if (!dateEl.value || !weightEl.value) {
        UI.showToast('Date and weight are required.', 'error');
        return;
      }
      const formData = {
        date:         dateEl.value,
        weightKg:     weightEl.value,
        caloriesKcal: UI.numOrNull(document.getElementById('edit-calories')),
        proteinG:     UI.numOrNull(document.getElementById('edit-protein')),
        carbsG:       UI.numOrNull(document.getElementById('edit-carbs')),
        fatG:         UI.numOrNull(document.getElementById('edit-fat')),
        sodiumMg:     UI.numOrNull(document.getElementById('edit-sodium')),
        waistCm:      UI.numOrNull(document.getElementById('edit-waist')),
        bicepCm:      UI.numOrNull(document.getElementById('edit-bicep')),
        thighCm:      UI.numOrNull(document.getElementById('edit-thigh')),
        nsv:           document.getElementById('edit-nsv').value.trim(),
        stepsCount:    UI.numOrNull(document.getElementById('edit-steps')),
        coachNotes:    document.getElementById('edit-coach-notes').value.trim() || null,
        sleepHours:    UI.numOrNull(document.getElementById('edit-sleep')),
        alcoholDrinks: UI.numOrNull(document.getElementById('edit-alcohol')),
        hungerLevel:   (() => { const el = document.getElementById('edit-hunger'); return (el && el.dataset.active === '1') ? parseInt(el.value) : null; })(),
        energyLevel:   (() => { const el = document.getElementById('edit-energy'); return (el && el.dataset.active === '1') ? parseInt(el.value) : null; })(),
        adherenceScore: document.getElementById('edit-adherence-score').value || null,
        adherenceWhy:   document.getElementById('edit-adherence-why').value || null
      };

      const idField = document.getElementById('edit-entry-id').value;
      if (isAdd) {
        Entries.add(formData);
      } else {
        Entries.update(idField, formData);
      }

      UI.hideModal(document.getElementById('edit-modal-overlay'));
      UI.showToast('Entry saved!', 'success');
      History.render();
    });
  },

  confirmDelete(id, fromModal = false) {
    const entry = Entries.getById(id);
    if (!entry) return;
    if (confirm(`Delete entry for ${UI.formatDate(entry.date)}? This cannot be undone.`)) {
      Entries.delete(id);
      if (fromModal) UI.hideModal(document.getElementById('edit-modal-overlay'));
      UI.showToast('Entry deleted.', 'info');
      History.render();
    }
  }
};

/* ============================================================
   ENTRY — daily entry form (page-entry)
   ============================================================ */
const Entry = {
  render() {
    const today = UI.todayISO();
    Entry._initCollapsibles();
    Entry._initForm(today);
    Entry._renderCoachTargetsCard(today);
  },

  _initCollapsibles() {
    document.querySelectorAll('.entry-card-header-collapsible').forEach(header => {
      // Clone to remove stale listeners
      const newHeader = header.cloneNode(true);
      header.parentNode.replaceChild(newHeader, header);
      newHeader.addEventListener('click', () => {
        const targetId = newHeader.dataset.target;
        const body = document.getElementById(targetId);
        if (!body) return;
        const collapsed = body.classList.toggle('collapsed');
        const arrow = newHeader.querySelector('.entry-collapse-arrow');
        if (arrow) arrow.textContent = collapsed ? '&#8963;' : '&#8964;';
      });
    });
  },

  _renderCoachTargetsCard(dateStr) {
    const card = document.getElementById('entry-coach-targets-card');
    const grid = document.getElementById('entry-coach-targets-grid');
    if (!card || !grid) return;
    if (!Coach.isEnabled()) { card.classList.add('hidden'); return; }

    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const [y, m, d] = dateStr.split('-').map(Number);
    const dayName = days[new Date(y, m - 1, d).getDay()];
    const plan = State.profile.coach?.weeklyPlan?.[dayName];
    if (!plan || (!plan.caloriesTarget && !plan.proteinTarget && !plan.fatTarget && !plan.carbsTarget)) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const chip = (label, val, unit) => val != null
      ? `<div class="coach-target-chip"><span class="coach-target-label">${label}</span><span class="coach-target-val">${val}${unit}</span></div>`
      : '';
    grid.innerHTML = [
      chip('Calories', plan.caloriesTarget, ' kcal'),
      chip('Protein',  plan.proteinTarget,  'g'),
      chip('Fat',      plan.fatTarget,      'g'),
      chip('Carbs',    plan.carbsTarget,    'g'),
      chip('Steps',    plan.stepsTarget != null ? Number(plan.stepsTarget).toLocaleString() : null, ''),
    ].join('');
  },

  _lockForm() {
    document.getElementById('daily-entry-form')?.classList.add('form-locked');
    document.getElementById('entry-submit-btn')?.classList.add('hidden');
    document.getElementById('entry-clear-btn')?.classList.add('hidden');
    document.getElementById('entry-edit-btn')?.classList.remove('hidden');
  },

  _unlockForm() {
    document.getElementById('daily-entry-form')?.classList.remove('form-locked');
    document.getElementById('entry-submit-btn')?.classList.remove('hidden');
    document.getElementById('entry-clear-btn')?.classList.remove('hidden');
    document.getElementById('entry-edit-btn')?.classList.add('hidden');
  },

  _initForm(today) {
    const dateInput   = document.getElementById('entry-date');
    const weightInput = document.getElementById('entry-weight');
    if (!dateInput || !weightInput) return;

    if (!dateInput.value) dateInput.value = today;

    const _applyExistingState = (dateStr) => {
      const ex = Entries.getById(dateStr);
      if (ex) {
        Entry._fillForm(ex);
        Entry._lockForm();
        document.getElementById('entry-mode-badge')?.classList.remove('hidden');
        const sb = document.getElementById('entry-submit-btn');
        if (sb) sb.textContent = 'Update Entry';
      } else {
        Entry._unlockForm();
        document.getElementById('daily-entry-form')?.reset();
        document.getElementById('entry-date').value = dateStr;
        Entry._clearComputedDisplay();
        Entry._resetWellbeing();
        document.getElementById('entry-mode-badge')?.classList.add('hidden');
        const sb = document.getElementById('entry-submit-btn');
        if (sb) sb.textContent = 'Save Entry';
      }
      Entry._renderCoachTargetsCard(dateStr);
      Coach.renderCheckInPanel(dateStr);
    };

    _applyExistingState(dateInput.value || today);

    const liveUpdate = () => {
      const date = document.getElementById('entry-date').value;
      const weight = parseFloat(document.getElementById('entry-weight').value);
      if (date && !isNaN(weight)) {
        Entry._displayComputed(Computed.forLiveEntry(date, weight));
      } else {
        Entry._clearComputedDisplay();
      }
    };

    // Clone weight input to remove stale listeners
    const newWeight = weightInput.cloneNode(true);
    weightInput.parentNode.replaceChild(newWeight, weightInput);
    newWeight.addEventListener('input', liveUpdate);
    newWeight.addEventListener('change', liveUpdate);

    // Clone date input
    const newDate = dateInput.cloneNode(true);
    dateInput.parentNode.replaceChild(newDate, dateInput);
    newDate.addEventListener('change', () => {
      _applyExistingState(newDate.value);
      liveUpdate();
    });

    // Form submit
    const form = document.getElementById('daily-entry-form');
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);
    document.getElementById('daily-entry-form').addEventListener('submit', Entry.handleSubmit);

    // Sliders
    const hungerSlider = document.getElementById('entry-hunger');
    const energySlider = document.getElementById('entry-energy');
    const hungerVal    = document.getElementById('hunger-val');
    const energyVal    = document.getElementById('energy-val');
    if (hungerSlider) hungerSlider.addEventListener('input', () => { if (hungerVal) hungerVal.textContent = hungerSlider.value; hungerSlider.dataset.active = '1'; });
    if (energySlider) energySlider.addEventListener('input', () => { if (energyVal) energyVal.textContent = energySlider.value; energySlider.dataset.active = '1'; });

    // Adherence
    Entry._bindAdherenceBtns(
      document.querySelectorAll('#daily-entry-form .adherence-btn'),
      document.querySelectorAll('#daily-entry-form .adherence-tag'),
      document.getElementById('adherence-why-row'),
      document.getElementById('entry-adherence-score'),
      document.getElementById('entry-adherence-why')
    );

    // Lifting day buttons
    Entry._bindLiftBtns(
      document.querySelectorAll('#daily-entry-form .lift-btn'),
      document.getElementById('entry-lifting-day')
    );

    // Edit Entry button (unlocks form)
    const editBtn = document.getElementById('entry-edit-btn');
    if (editBtn) {
      const newEditBtn = editBtn.cloneNode(true);
      editBtn.parentNode.replaceChild(newEditBtn, editBtn);
      newEditBtn.addEventListener('click', () => Entry._unlockForm());
    }

    // Clear button
    const clearBtn = document.getElementById('entry-clear-btn');
    if (clearBtn) {
      const newClear = clearBtn.cloneNode(true);
      clearBtn.parentNode.replaceChild(newClear, clearBtn);
      newClear.addEventListener('click', () => {
        document.getElementById('daily-entry-form').reset();
        document.getElementById('entry-date').value = today;
        Entry._renderCoachTargetsCard(today);
        Coach.renderCheckInPanel(today);
        Entry._clearComputedDisplay();
        document.getElementById('entry-mode-badge')?.classList.add('hidden');
        const sb = document.getElementById('entry-submit-btn');
        if (sb) sb.textContent = 'Save Entry';
        Entry._resetWellbeing();
        Entry._unlockForm();
      });
    }
  },

  _bindLiftBtns(btns, hiddenInput) {
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (hiddenInput) hiddenInput.value = btn.dataset.lift;
      });
    });
  },

  handleSubmit(e) {
    e.preventDefault();
    const dateEl   = document.getElementById('entry-date');
    const weightEl = document.getElementById('entry-weight');

    if (!dateEl.value) { UI.showToast('Please select a date.', 'error'); return; }
    if (!weightEl.value || isNaN(parseFloat(weightEl.value))) { UI.showToast('Weight is required.', 'error'); return; }

    const liftVal = document.getElementById('entry-lifting-day')?.value;
    const formData = {
      date:         dateEl.value,
      weightKg:     weightEl.value,
      caloriesKcal: UI.numOrNull(document.getElementById('entry-calories')),
      proteinG:     UI.numOrNull(document.getElementById('entry-protein')),
      carbsG:       UI.numOrNull(document.getElementById('entry-carbs')),
      fatG:         UI.numOrNull(document.getElementById('entry-fat')),
      sodiumMg:     UI.numOrNull(document.getElementById('entry-sodium')),
      waistCm:      UI.numOrNull(document.getElementById('entry-waist')),
      bicepCm:      UI.numOrNull(document.getElementById('entry-bicep')),
      thighCm:      UI.numOrNull(document.getElementById('entry-thigh')),
      nsv:           document.getElementById('entry-nsv').value.trim(),
      stepsCount:    UI.numOrNull(document.getElementById('entry-steps')),
      coachNotes:    document.getElementById('entry-coach-notes').value.trim() || null,
      sleepHours:    UI.numOrNull(document.getElementById('entry-sleep')),
      alcoholDrinks: UI.numOrNull(document.getElementById('entry-alcohol')),
      hungerLevel:   (() => { const el = document.getElementById('entry-hunger'); return (el && el.dataset.active === '1') ? parseInt(el.value) : null; })(),
      energyLevel:   (() => { const el = document.getElementById('entry-energy'); return (el && el.dataset.active === '1') ? parseInt(el.value) : null; })(),
      adherenceScore: document.getElementById('entry-adherence-score').value || null,
      adherenceWhy:   document.getElementById('entry-adherence-why').value || null,
      liftingDay:     liftVal === 'yes' ? true : (liftVal === 'no' ? false : null)
    };

    const existing = Entries.getById(formData.date);
    if (existing) {
      Entries.update(formData.date, formData);
      UI.showToast('Entry updated!', 'success');
    } else {
      const saved = Entries.add(formData);
      if (!saved) return;
      UI.showToast('Entry saved!', 'success');
    }
    // Re-fill and re-lock after saving
    const savedEntry = Entries.getById(formData.date);
    if (savedEntry) Entry._fillForm(savedEntry);
    Entry._lockForm();
    document.getElementById('entry-mode-badge')?.classList.remove('hidden');
    const sb = document.getElementById('entry-submit-btn');
    if (sb) sb.textContent = 'Update Entry';
  },

  _fillForm(entry) {
    UI.setInputVal(document.getElementById('entry-date'),     entry.date);
    UI.setInputVal(document.getElementById('entry-weight'),   entry.weightKg);
    UI.setInputVal(document.getElementById('entry-calories'), entry.caloriesKcal);
    UI.setInputVal(document.getElementById('entry-protein'),  entry.proteinG);
    UI.setInputVal(document.getElementById('entry-carbs'),    entry.carbsG);
    UI.setInputVal(document.getElementById('entry-fat'),      entry.fatG);
    UI.setInputVal(document.getElementById('entry-sodium'),   entry.sodiumMg);
    UI.setInputVal(document.getElementById('entry-waist'),    entry.waistCm);
    UI.setInputVal(document.getElementById('entry-bicep'),    entry.bicepCm);
    UI.setInputVal(document.getElementById('entry-thigh'),    entry.thighCm);
    UI.setInputVal(document.getElementById('entry-nsv'),      entry.nsv);
    UI.setInputVal(document.getElementById('entry-steps'),    entry.stepsCount);
    UI.setInputVal(document.getElementById('entry-coach-notes'), entry.coachNotes || '');
    UI.setInputVal(document.getElementById('entry-sleep'),    entry.sleepHours);
    UI.setInputVal(document.getElementById('entry-alcohol'),  entry.alcoholDrinks);
    // Lifting day buttons
    const liftHidden = document.getElementById('entry-lifting-day');
    document.querySelectorAll('#daily-entry-form .lift-btn').forEach(btn => {
      btn.classList.remove('active');
      if (entry.liftingDay === true  && btn.dataset.lift === 'yes') btn.classList.add('active');
      if (entry.liftingDay === false && btn.dataset.lift === 'no')  btn.classList.add('active');
    });
    if (liftHidden) liftHidden.value = entry.liftingDay === true ? 'yes' : (entry.liftingDay === false ? 'no' : '');
    const hungerSlider = document.getElementById('entry-hunger');
    const energySlider = document.getElementById('entry-energy');
    const hungerVal    = document.getElementById('hunger-val');
    const energyVal    = document.getElementById('energy-val');
    if (entry.hungerLevel !== null && entry.hungerLevel !== undefined) {
      if (hungerSlider) { hungerSlider.value = entry.hungerLevel; hungerSlider.dataset.active = '1'; }
      if (hungerVal)    hungerVal.textContent = entry.hungerLevel;
    } else {
      if (hungerSlider) { hungerSlider.value = 5; hungerSlider.dataset.active = '0'; }
      if (hungerVal)    hungerVal.textContent = '—';
    }
    if (entry.energyLevel !== null && entry.energyLevel !== undefined) {
      if (energySlider) { energySlider.value = entry.energyLevel; energySlider.dataset.active = '1'; }
      if (energyVal)    energyVal.textContent = entry.energyLevel;
    } else {
      if (energySlider) { energySlider.value = 5; energySlider.dataset.active = '0'; }
      if (energyVal)    energyVal.textContent = '—';
    }
    const scoreHidden = document.getElementById('entry-adherence-score');
    const whyHidden   = document.getElementById('entry-adherence-why');
    if (scoreHidden) scoreHidden.value = entry.adherenceScore || '';
    if (whyHidden)   whyHidden.value   = entry.adherenceWhy   || '';
    document.querySelectorAll('#daily-entry-form .adherence-btn').forEach(btn => {
      btn.className = 'adherence-btn';
      if (entry.adherenceScore && btn.dataset.score === entry.adherenceScore)
        btn.classList.add('active-' + Entry._adherenceClass(entry.adherenceScore));
    });
    const whyRow = document.getElementById('adherence-why-row');
    if (whyRow) whyRow.classList.toggle('hidden', !entry.adherenceScore || entry.adherenceScore === 'on_plan');
    document.querySelectorAll('#daily-entry-form .adherence-tag').forEach(tag => {
      tag.classList.toggle('active', tag.dataset.why === entry.adherenceWhy);
    });
    Entry._displayComputed({
      kgFromPrev:   entry.kgLostFromPrev,
      totalKgLost:  entry.totalKgLost,
      totalPctLost: entry.totalPctLost,
      bmi:          entry.bmi
    });
  },

  _displayComputed({ kgFromPrev, totalKgLost, totalPctLost, bmi }) {
    const prevEl = document.getElementById('calc-kg-from-prev');
    if (prevEl) {
      if (kgFromPrev === null) {
        prevEl.textContent = 'First entry';
        prevEl.classList.remove('negative');
      } else {
        const sign = kgFromPrev > 0 ? '−' : kgFromPrev < 0 ? '+' : '';
        prevEl.textContent = kgFromPrev === 0 ? '0.0 kg' : `${sign}${Math.abs(kgFromPrev).toFixed(2)} kg`;
        prevEl.classList.toggle('negative', kgFromPrev < 0);
      }
    }
    const totalEl = document.getElementById('calc-total-kg-lost');
    if (totalEl) {
      totalEl.textContent = totalKgLost !== null ? `${UI.formatNum(totalKgLost, 2)} kg` : '—';
      totalEl.classList.toggle('negative', totalKgLost !== null && totalKgLost < 0);
    }
    const pctEl = document.getElementById('calc-pct-lost');
    if (pctEl) pctEl.textContent = totalPctLost !== null ? `${UI.formatNum(totalPctLost, 1)}%` : '—';
    const bmiEl = document.getElementById('calc-bmi');
    if (bmiEl) bmiEl.textContent = bmi !== null ? `${UI.formatNum(bmi, 1)} (${Computed.bmiCategory(bmi)})` : '—';
  },

  _clearComputedDisplay() {
    ['calc-kg-from-prev','calc-total-kg-lost','calc-pct-lost','calc-bmi'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = '—'; el.classList.remove('negative'); }
    });
  },

  _adherenceClass(score) {
    if (score === 'on_plan') return 'on';
    if (score === 'close')   return 'close';
    return 'off';
  },

  _bindAdherenceBtns(btns, tags, whyRow, scoreHidden, whyHidden) {
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        const score = btn.dataset.score;
        scoreHidden.value = score;
        btns.forEach(b => b.className = 'adherence-btn');
        btn.classList.add('active-' + Entry._adherenceClass(score));
        if (score === 'on_plan') {
          whyRow.classList.add('hidden');
          if (whyHidden) whyHidden.value = '';
          tags.forEach(t => t.classList.remove('active'));
        } else {
          whyRow.classList.remove('hidden');
        }
      });
    });
    tags.forEach(tag => {
      tag.addEventListener('click', () => {
        tags.forEach(t => t.classList.remove('active'));
        tag.classList.add('active');
        if (whyHidden) whyHidden.value = tag.dataset.why;
      });
    });
  },

  _resetWellbeing() {
    const hungerSlider = document.getElementById('entry-hunger');
    const energySlider = document.getElementById('entry-energy');
    if (hungerSlider) { hungerSlider.value = 5; hungerSlider.dataset.active = '0'; }
    if (energySlider) { energySlider.value = 5; energySlider.dataset.active = '0'; }
    const hungerVal = document.getElementById('hunger-val');
    const energyVal = document.getElementById('energy-val');
    if (hungerVal) hungerVal.textContent = '—';
    if (energyVal) energyVal.textContent = '—';
    const scoreHidden = document.getElementById('entry-adherence-score');
    const whyHidden   = document.getElementById('entry-adherence-why');
    if (scoreHidden) scoreHidden.value = '';
    if (whyHidden)   whyHidden.value   = '';
    document.querySelectorAll('#daily-entry-form .adherence-btn').forEach(b => b.className = 'adherence-btn');
    document.querySelectorAll('#daily-entry-form .adherence-tag').forEach(t => t.classList.remove('active'));
    const whyRow = document.getElementById('adherence-why-row');
    if (whyRow) whyRow.classList.add('hidden');
    // Reset lifting day
    document.querySelectorAll('#daily-entry-form .lift-btn').forEach(b => b.classList.remove('active'));
    const liftHidden = document.getElementById('entry-lifting-day');
    if (liftHidden) liftHidden.value = '';
  }
};

/* ============================================================
   CHARTS — Chart.js visualizations
   ============================================================ */
const Charts = {
  /** Apply dark-theme defaults to Chart.js globally (called once at init). */
  applyDefaults() {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.color          = '#9ca3af';
    Chart.defaults.borderColor    = '#2e2e2e';
    Chart.defaults.font.family    = 'Segoe UI, system-ui, sans-serif';
    Chart.defaults.font.size      = 12;
  },

  /** Destroy all active Chart.js instances to allow canvas reuse. */
  destroyAll() {
    Object.keys(State.charts).forEach(key => {
      if (State.charts[key]) {
        State.charts[key].destroy();
        State.charts[key] = null;
      }
    });
  },

  /** Simple linear regression → array of fitted y values (nulls preserved for gaps). */
  _calcLinearRegression(data) {
    const pts = data.map((y, x) => ({ x, y })).filter(p => p.y !== null && p.y !== undefined && !isNaN(p.y));
    if (pts.length < 2) return data.map(() => null);
    const n = pts.length;
    const sumX  = pts.reduce((s, p) => s + p.x, 0);
    const sumY  = pts.reduce((s, p) => s + p.y, 0);
    const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0);
    const sumX2 = pts.reduce((s, p) => s + p.x * p.x, 0);
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return data.map(() => null);
    const m = (n * sumXY - sumX * sumY) / denom;
    const b = (sumY - m * sumX) / n;
    return data.map((_, i) => parseFloat((m * i + b).toFixed(2)));
  },

  /** Minimal Chart.js options for mini charts on the Summary page. */
  _miniConfig(yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1f1f1f', titleColor: '#f0f0f0',
          bodyColor: '#9ca3af', borderColor: '#2e2e2e', borderWidth: 1, padding: 8
        }
      },
      scales: {
        x: { ticks: { color: '#6b7280', maxRotation: 45, font: { size: 9 } }, grid: { color: '#1f1f1f' } },
        y: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: '#1f1f1f' },
             title: { display: !!yLabel, text: yLabel, color: '#6b7280', font: { size: 10 } } }
      }
    };
  },

  /** Return the coach daily target for a given field and date (by day of week). */
  _coachTargetForDate(dateStr, field) {
    if (!Coach.isEnabled()) return null;
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const [y, m, d] = dateStr.split('-').map(Number);
    const dayName = days[new Date(y, m - 1, d).getDay()];
    return State.profile.coach?.weeklyPlan?.[dayName]?.[field] || null;
  },

  /** Render all charts on the Graphs page. */
  render() {
    const allEntries = Entries.getSorted();

    // Preserve current range/date values before cloning
    const rangeVal   = document.getElementById('graphs-range-select').value;
    const fromVal    = document.getElementById('graphs-from-date')?.value || '';
    const toVal      = document.getElementById('graphs-to-date')?.value || '';

    // Re-bind range select (clone removes stale listeners)
    const rangeSelect = document.getElementById('graphs-range-select');
    const newRange = rangeSelect.cloneNode(true);
    newRange.value = rangeVal;
    rangeSelect.parentNode.replaceChild(newRange, rangeSelect);

    const customRangeEl = document.getElementById('graphs-custom-range');
    const fromEl = document.getElementById('graphs-from-date');
    const toEl   = document.getElementById('graphs-to-date');
    if (fromEl) fromEl.value = fromVal;
    if (toEl)   toEl.value   = toVal;

    const _applyAndRender = () => {
      const sel = document.getElementById('graphs-range-select').value;
      if (customRangeEl) customRangeEl.classList.toggle('hidden', sel !== 'custom');
      Charts._renderCharts(allEntries);
    };

    newRange.addEventListener('change', _applyAndRender);
    // Custom range apply button
    const applyBtn = document.getElementById('graphs-apply-range');
    if (applyBtn) {
      const newApply = applyBtn.cloneNode(true);
      applyBtn.parentNode.replaceChild(newApply, applyBtn);
      newApply.addEventListener('click', () => Charts._renderCharts(allEntries));
    }
    // Show/hide custom range row immediately
    if (customRangeEl) customRangeEl.classList.toggle('hidden', rangeVal !== 'custom');

    Charts._renderCharts(allEntries);
  },

  /** Internal: filter and draw all charts. */
  _renderCharts(allEntries) {
    Charts.destroyAll();
    const rangeVal = document.getElementById('graphs-range-select').value;
    const entries = Charts._filterByRange(allEntries, rangeVal);

    const emptyMsg  = document.getElementById('graphs-empty');
    const chartsGrid = document.getElementById('charts-grid');

    if (entries.length === 0) {
      emptyMsg.classList.remove('hidden');
      chartsGrid.classList.add('hidden');
      return;
    }
    emptyMsg.classList.add('hidden');
    chartsGrid.classList.remove('hidden');

    const labels = entries.map(e => UI.formatDate(e.date));
    Charts._createWeightChart(labels, entries);
    Charts._createKgLostChart(labels, entries);
    Charts._createBMIChart(labels, entries);
    Charts._createCaloriesChart(labels, entries);
    Charts._createMacrosChart(labels, entries);
    Charts._createMeasurementsChart(labels, entries);
    Charts._createStepsChart(labels, entries);
    Charts._createSodiumChart(labels, entries);
    Charts._createSodiumWeightChart(labels, entries);
    Charts._createPointsChart(labels, entries);
    Charts._createCoachCheckInsChart(entries);
  },

  /** Filter entries by range. Supports last-N-days or custom from/to. */
  _filterByRange(entries, rangeVal) {
    if (rangeVal === 'custom') {
      const fromISO = document.getElementById('graphs-from-date')?.value || '';
      const toISO   = document.getElementById('graphs-to-date')?.value   || '';
      if (!fromISO && !toISO) return entries;
      return entries.filter(e =>
        (!fromISO || e.date >= fromISO) &&
        (!toISO   || e.date <= toISO)
      );
    }
    if (rangeVal === 'all' || !rangeVal) return entries;
    const days = parseInt(rangeVal);
    if (isNaN(days)) return entries;
    const today = UI.todayISO();
    return entries.filter(e => UI.dateDiffDays(e.date, today) <= days);
  },

  /** Base Chart.js config spread into all charts. */
  _baseConfig() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#9ca3af', padding: 16, font: { size: 11 } }
        },
        tooltip: {
          backgroundColor: '#1f1f1f',
          titleColor:      '#f0f0f0',
          bodyColor:       '#9ca3af',
          borderColor:     '#2e2e2e',
          borderWidth:     1,
          padding:         10,
          cornerRadius:    6
        }
      },
      scales: {
        x: {
          ticks: { color: '#6b7280', maxRotation: 45, font: { size: 10 } },
          grid:  { color: '#1f1f1f' }
        },
        y: {
          ticks: { color: '#6b7280', font: { size: 11 } },
          grid:  { color: '#1f1f1f' }
        }
      }
    };
  },

  /** Line chart: weight over time + trend line + goal line */
  _createWeightChart(labels, entries) {
    const goalW = State.profile.goalWeightKg;
    const trendValues = Computed.calcTrendWeights(entries);
    const datasets = [
      {
        label: 'Weight (kg)',
        data: entries.map(e => e.weightKg),
        borderColor: '#60a5fa',
        backgroundColor: 'rgba(96, 165, 250, 0.1)',
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: 0.3,
        fill: true,
        spanGaps: false
      },
      {
        label: '7-day trend',
        data: trendValues,
        borderColor: '#a78bfa',
        borderWidth: 2,
        borderDash: [5, 3],
        pointRadius: 0,
        fill: false,
        spanGaps: true,
        tension: 0.3
      }
    ];
    if (goalW) {
      datasets.push({
        label: `Goal (${goalW} kg)`,
        data: entries.map(() => goalW),
        borderColor: '#4ade80',
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        fill: false
      });
    }
    // Target pace line: if user set a weekly kg goal
    const weeklyGoal = State.profile.weeklyGoalKg;
    const journeyStart = State.profile.journeyStartDate;
    const startW = State.profile.startingWeightKg;
    if (weeklyGoal && journeyStart && startW) {
      const targetPaceData = entries.map(e => {
        const days = UI.dateDiffDays(journeyStart, e.date);
        const target = startW - (weeklyGoal * days / 7);
        return parseFloat(Math.max(goalW || 0, target).toFixed(1));
      });
      datasets.push({
        label: `Target pace (${weeklyGoal} kg/wk)`,
        data: targetPaceData,
        borderColor: '#fb923c',
        borderWidth: 1.5,
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false
      });
    }
    const cfg = Charts._baseConfig();
    cfg.scales.y.title = { display: true, text: 'kg', color: '#6b7280' };
    State.charts.weight = new Chart(document.getElementById('chart-weight'), {
      type: 'line', data: { labels, datasets }, options: cfg
    });
  },

  /** Line chart: total kg lost over time with linear trend */
  _createKgLostChart(labels, entries) {
    const kgData = entries.map(e => e.totalKgLost);
    const trendLine = Charts._calcLinearRegression(kgData);
    const cfg = Charts._baseConfig();
    cfg.scales.y.title = { display: true, text: 'kg lost', color: '#6b7280' };
    State.charts.kgLost = new Chart(document.getElementById('chart-kg-lost'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Total kg Lost',
            data: kgData,
            borderColor: '#4ade80',
            backgroundColor: 'rgba(74,222,128,0.1)',
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.3,
            fill: true,
            spanGaps: false
          },
          {
            label: 'Trend',
            data: trendLine,
            borderColor: '#fbbf24',
            borderWidth: 1.5,
            borderDash: [6, 3],
            pointRadius: 0,
            fill: false,
            spanGaps: true,
            tension: 0
          }
        ]
      },
      options: cfg
    });
  },

  /** Line chart: BMI trend with reference bands */
  _createBMIChart(labels, entries) {
    const cfg = Charts._baseConfig();
    cfg.scales.y.title = { display: true, text: 'BMI', color: '#6b7280' };
    const datasets = [
      {
        label: 'BMI',
        data: entries.map(e => e.bmi || null),
        borderColor: '#fbbf24',
        backgroundColor: 'rgba(251, 191, 36, 0.1)',
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.3,
        fill: true,
        spanGaps: false
      },
      {
        label: 'Overweight (25)',
        data: entries.map(() => 25),
        borderColor: 'rgba(251, 191, 36, 0.4)',
        borderWidth: 1,
        borderDash: [4, 3],
        pointRadius: 0,
        fill: false
      },
      {
        label: 'Obese (30)',
        data: entries.map(() => 30),
        borderColor: 'rgba(248, 113, 113, 0.4)',
        borderWidth: 1,
        borderDash: [4, 3],
        pointRadius: 0,
        fill: false
      }
    ];
    State.charts.bmi = new Chart(document.getElementById('chart-bmi'), {
      type: 'line', data: { labels, datasets }, options: cfg
    });
  },

  /** Bar chart: daily calorie intake with coach compliance coloring */
  _createCaloriesChart(labels, entries) {
    const cfg = Charts._baseConfig();
    cfg.scales.y.title = { display: true, text: 'kcal', color: '#6b7280' };
    const coachEnabled = Coach.isEnabled();
    const datasets = [{
      label: 'Calories (kcal)',
      data: entries.map(e => e.caloriesKcal),
      backgroundColor: entries.map(e => {
        if (!coachEnabled || e.caloriesKcal === null) return 'rgba(96,165,250,0.6)';
        const target = Charts._coachTargetForDate(e.date, 'caloriesTarget');
        if (!target) return 'rgba(96,165,250,0.6)';
        return e.caloriesKcal <= target ? 'rgba(74,222,128,0.65)' : 'rgba(248,113,113,0.65)';
      }),
      borderColor: entries.map(e => {
        if (!coachEnabled || e.caloriesKcal === null) return '#60a5fa';
        const target = Charts._coachTargetForDate(e.date, 'caloriesTarget');
        if (!target) return '#60a5fa';
        return e.caloriesKcal <= target ? '#4ade80' : '#f87171';
      }),
      borderWidth: 1,
      borderRadius: 3
    }];
    if (coachEnabled) {
      const targetData = entries.map(e => Charts._coachTargetForDate(e.date, 'caloriesTarget'));
      if (targetData.some(v => v !== null)) {
        datasets.push({
          label: 'Daily Target',
          data: targetData,
          type: 'line',
          borderColor: '#fbbf24',
          borderWidth: 2,
          borderDash: [6, 3],
          pointRadius: 0,
          fill: false,
          spanGaps: true
        });
      }
    }
    State.charts.calories = new Chart(document.getElementById('chart-calories'), {
      type: 'bar', data: { labels, datasets }, options: cfg
    });
  },

  /** Stacked bar chart: protein, carbs, fat over time with optional coach targets */
  _createMacrosChart(labels, entries) {
    const cfg = Charts._baseConfig();
    cfg.scales.y.title = { display: true, text: 'grams', color: '#6b7280' };
    cfg.scales.y.stacked = true;
    cfg.scales.x.stacked = true;
    const datasets = [
      { label: 'Protein (g)',       data: entries.map(e => e.proteinG), backgroundColor: 'rgba(74,222,128,0.7)',  borderRadius: 2 },
      { label: 'Carbohydrates (g)', data: entries.map(e => e.carbsG),   backgroundColor: 'rgba(96,165,250,0.7)',  borderRadius: 2 },
      { label: 'Fat (g)',           data: entries.map(e => e.fatG),      backgroundColor: 'rgba(251,191,36,0.7)', borderRadius: 2 }
    ];
    if (Coach.isEnabled()) {
      const proteinTargets = entries.map(e => Charts._coachTargetForDate(e.date, 'proteinTarget'));
      const fatTargets     = entries.map(e => Charts._coachTargetForDate(e.date, 'fatTarget'));
      const carbsTargets   = entries.map(e => Charts._coachTargetForDate(e.date, 'carbsTarget'));
      const addTarget = (label, data, color) => {
        if (!data.some(v => v !== null)) return;
        datasets.push({ label, data, type: 'line', borderColor: color, borderWidth: 1.5, borderDash: [5,3], pointRadius: 0, fill: false, spanGaps: true, stack: undefined });
      };
      addTarget('Protein Target', proteinTargets, '#86efac');
      addTarget('Fat Target',     fatTargets,     '#fde68a');
      addTarget('Carbs Target',   carbsTargets,   '#93c5fd');
    }
    State.charts.macros = new Chart(document.getElementById('chart-macros'), {
      type: 'bar', data: { labels, datasets }, options: cfg
    });
  },

  /** Multi-line chart: waist, bicep, thigh measurements */
  _createMeasurementsChart(labels, entries) {
    const cfg = Charts._baseConfig();
    cfg.scales.y.title = { display: true, text: 'cm', color: '#6b7280' };
    State.charts.measurements = new Chart(document.getElementById('chart-measurements'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Waist (cm)', data: entries.map(e => e.waistCm), borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,0.1)', borderWidth: 2, pointRadius: 3, tension: 0.3, spanGaps: false },
          { label: 'Bicep (cm)', data: entries.map(e => e.bicepCm), borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.1)', borderWidth: 2, pointRadius: 3, tension: 0.3, spanGaps: false },
          { label: 'Thigh (cm)', data: entries.map(e => e.thighCm), borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.1)',  borderWidth: 2, pointRadius: 3, tension: 0.3, spanGaps: false }
        ]
      },
      options: cfg
    });
  },

  /** Bar + trend line: daily step count */
  _createStepsChart(labels, entries) {
    const canvas = document.getElementById('chart-steps');
    if (!canvas) return;
    const stepsData = entries.map(e => e.stepsCount !== null && e.stepsCount !== undefined ? e.stepsCount : null);
    const trendLine = Charts._calcLinearRegression(stepsData);
    const cfg = Charts._baseConfig();
    cfg.scales.y.title = { display: true, text: 'steps', color: '#6b7280' };
    const datasets = [
      {
        label: 'Steps',
        data: stepsData,
        backgroundColor: 'rgba(74,222,128,0.5)',
        borderColor: '#4ade80',
        borderWidth: 1,
        borderRadius: 3
      },
      {
        label: 'Trend',
        data: trendLine,
        type: 'line',
        borderColor: '#fbbf24',
        borderWidth: 2,
        borderDash: [6, 3],
        pointRadius: 0,
        fill: false,
        spanGaps: true,
        tension: 0
      }
    ];
    if (Coach.isEnabled()) {
      const stepsTargets = entries.map(e => Charts._coachTargetForDate(e.date, 'stepsTarget'));
      if (stepsTargets.some(v => v !== null)) {
        datasets.push({ label: 'Target', data: stepsTargets, type: 'line', borderColor: '#a78bfa', borderWidth: 1.5, borderDash: [5,3], pointRadius: 0, fill: false, spanGaps: true });
      }
    }
    State.charts.steps = new Chart(canvas, { type: 'bar', data: { labels, datasets }, options: cfg });
  },

  /** Bar + trend line: daily sodium intake */
  _createSodiumChart(labels, entries) {
    const canvas = document.getElementById('chart-sodium');
    if (!canvas) return;
    const sodiumData = entries.map(e => e.sodiumMg);
    const trendLine  = Charts._calcLinearRegression(sodiumData);
    const cfg = Charts._baseConfig();
    cfg.scales.y.title = { display: true, text: 'mg', color: '#6b7280' };
    // Recommended daily limit reference line at 2300 mg
    State.charts.sodium = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Sodium (mg)',
            data: sodiumData,
            backgroundColor: sodiumData.map(v => v !== null && v > 2300 ? 'rgba(248,113,113,0.6)' : 'rgba(96,165,250,0.6)'),
            borderColor:      sodiumData.map(v => v !== null && v > 2300 ? '#f87171'               : '#60a5fa'),
            borderWidth: 1,
            borderRadius: 3
          },
          {
            label: 'Trend',
            data: trendLine,
            type: 'line',
            borderColor: '#fbbf24',
            borderWidth: 2,
            borderDash: [6, 3],
            pointRadius: 0,
            fill: false,
            spanGaps: true,
            tension: 0
          },
          {
            label: 'Limit (2300 mg)',
            data: entries.map(() => 2300),
            type: 'line',
            borderColor: 'rgba(248,113,113,0.5)',
            borderWidth: 1.5,
            borderDash: [4, 4],
            pointRadius: 0,
            fill: false
          }
        ]
      },
      options: cfg
    });
  },

  /** Bar chart: daily gamification points (max 5) + running total line */
  _createPointsChart(labels, entries) {
    const canvas = document.getElementById('chart-points');
    if (!canvas) return;
    const pointsData = entries.map(e => Computed.calcPoints(e));
    let total = 0;
    const runningTotal = pointsData.map(p => { total += p; return total; });
    const cfg = Charts._baseConfig();
    cfg.scales.y = {
      type: 'linear', position: 'left',
      min: 0, max: 5,
      title: { display: true, text: 'points / day', color: '#6b7280' },
      ticks: { color: '#6b7280', font: { size: 11 }, stepSize: 1 },
      grid: { color: '#1f1f1f' }
    };
    cfg.scales.y1 = {
      type: 'linear', position: 'right',
      title: { display: true, text: 'total points', color: '#fbbf24' },
      ticks: { color: '#6b7280', font: { size: 11 } },
      grid: { drawOnChartArea: false }
    };
    State.charts.points = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Points earned',
            data: pointsData,
            backgroundColor: pointsData.map(p => p >= 4 ? 'rgba(74,222,128,0.75)' : p >= 2 ? 'rgba(251,191,36,0.75)' : 'rgba(248,113,113,0.75)'),
            borderColor:      pointsData.map(p => p >= 4 ? '#4ade80'              : p >= 2 ? '#fbbf24'              : '#f87171'),
            borderWidth: 1, borderRadius: 3, yAxisID: 'y'
          },
          {
            label: 'Running total',
            data: runningTotal,
            type: 'line',
            borderColor: '#fbbf24',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            tension: 0.3,
            yAxisID: 'y1'
          }
        ]
      },
      options: cfg
    });
  },

  /** Line chart: weight at each coach check-in date + trend */
  _createCoachCheckInsChart(entries) {
    const canvas = document.getElementById('chart-coach-checkins');
    if (!canvas) return;
    const wrap = canvas.closest('.chart-card');
    if (!Coach.isEnabled()) { if (wrap) wrap.classList.add('hidden'); return; }

    const checkInEntries = entries.filter(e => Coach.isCheckInDay(e.date));
    if (checkInEntries.length === 0) { if (wrap) wrap.classList.add('hidden'); return; }
    if (wrap) wrap.classList.remove('hidden');

    const ciLabels = checkInEntries.map(e => UI.formatDate(e.date));
    const weightData = checkInEntries.map(e => e.weightKg);
    const trendLine = Charts._calcLinearRegression(weightData);

    // kg lost vs previous check-in
    const kgLostPerPeriod = checkInEntries.map((e, i) => {
      if (i === 0) return null;
      const prev = checkInEntries[i - 1];
      return (prev.weightKg && e.weightKg) ? parseFloat((prev.weightKg - e.weightKg).toFixed(2)) : null;
    });

    const cfg = Charts._baseConfig();
    cfg.scales.y = {
      type: 'linear', position: 'left',
      title: { display: true, text: 'Weight (kg)', color: '#a78bfa' },
      ticks: { color: '#6b7280', font: { size: 11 } },
      grid: { color: '#1f1f1f' }
    };
    cfg.scales.y1 = {
      type: 'linear', position: 'right',
      title: { display: true, text: 'kg lost (period)', color: '#4ade80' },
      ticks: { color: '#6b7280', font: { size: 11 } },
      grid: { drawOnChartArea: false }
    };

    State.charts.coachCheckIns = new Chart(canvas, {
      type: 'line',
      data: {
        labels: ciLabels,
        datasets: [
          {
            label: 'Weight at check-in (kg)',
            data: weightData,
            borderColor: '#a78bfa',
            backgroundColor: 'rgba(167,139,250,0.1)',
            borderWidth: 2,
            pointRadius: 5,
            pointHoverRadius: 8,
            tension: 0.3,
            fill: true,
            yAxisID: 'y'
          },
          {
            label: 'Trend',
            data: trendLine,
            borderColor: '#fbbf24',
            borderWidth: 1.5,
            borderDash: [6, 3],
            pointRadius: 0,
            fill: false,
            spanGaps: true,
            yAxisID: 'y'
          },
          {
            label: 'kg lost vs prev check-in',
            data: kgLostPerPeriod,
            type: 'bar',
            backgroundColor: kgLostPerPeriod.map(v => v === null ? 'transparent' : v >= 0 ? 'rgba(74,222,128,0.6)' : 'rgba(248,113,113,0.6)'),
            borderColor:      kgLostPerPeriod.map(v => v === null ? 'transparent' : v >= 0 ? '#4ade80'              : '#f87171'),
            borderWidth: 1,
            borderRadius: 3,
            yAxisID: 'y1'
          }
        ]
      },
      options: cfg
    });
  },

  /** Dual-axis: sodium bars + next-day weight change line */
  _createSodiumWeightChart(labels, entries) {
    const canvas = document.getElementById('chart-sodium-weight');
    if (!canvas) return;

    // For each entry, next-day weight change
    const nextDayWeightChange = entries.map((e, i) => {
      if (e.sodiumMg === null) return null;
      const next = entries[i + 1];
      if (!next || !next.weightKg || !e.weightKg) return null;
      return parseFloat((next.weightKg - e.weightKg).toFixed(2));
    });

    const sodiumData = entries.map(e => e.sodiumMg);
    const cfg = Charts._baseConfig();
    cfg.scales.y = {
      type: 'linear', position: 'left',
      title: { display: true, text: 'Sodium (mg)', color: '#60a5fa' },
      ticks: { color: '#6b7280', font: { size: 11 } },
      grid: { color: '#1f1f1f' }
    };
    cfg.scales.y1 = {
      type: 'linear', position: 'right',
      title: { display: true, text: 'Next-day Δ weight (kg)', color: '#f87171' },
      ticks: { color: '#6b7280', font: { size: 11 } },
      grid: { drawOnChartArea: false }
    };

    State.charts.sodiumWeight = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Sodium (mg)',
            data: sodiumData,
            backgroundColor: 'rgba(96,165,250,0.5)',
            borderColor: '#60a5fa',
            borderWidth: 1,
            borderRadius: 3,
            yAxisID: 'y'
          },
          {
            label: 'Next-day weight change (kg)',
            data: nextDayWeightChange,
            type: 'line',
            borderColor: '#f87171',
            backgroundColor: 'rgba(248,113,113,0.1)',
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            fill: false,
            spanGaps: false,
            tension: 0.3,
            yAxisID: 'y1'
          }
        ]
      },
      options: cfg
    });
  }
};

/* ============================================================
   PROFILE — profile form + computed stat cards
   ============================================================ */
const Profile = {
  render() {
    const p = State.profile;

    // Populate form fields
    UI.setInputVal(document.getElementById('profile-name'),             p.name);
    UI.setInputVal(document.getElementById('profile-dob'),              p.dob);
    UI.setInputVal(document.getElementById('profile-height'),           p.heightCm || '');
    UI.setInputVal(document.getElementById('profile-start-date'),       p.journeyStartDate);
    UI.setInputVal(document.getElementById('profile-starting-weight'),  p.startingWeightKg || '');
    UI.setInputVal(document.getElementById('profile-goal-weight'),      p.goalWeightKg || '');
    UI.setInputVal(document.getElementById('profile-weekly-goal-kg'),   p.weeklyGoalKg || '');

    // Computed stat cards
    Profile._updateStatCards();

    // Bind form submit (clone to remove old listeners)
    const form = document.getElementById('profile-form');
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);
    document.getElementById('profile-form').addEventListener('submit', Profile.handleSubmit);

    // Re-populate after clone
    UI.setInputVal(document.getElementById('profile-name'),             p.name);
    UI.setInputVal(document.getElementById('profile-dob'),              p.dob);
    UI.setInputVal(document.getElementById('profile-height'),           p.heightCm || '');
    UI.setInputVal(document.getElementById('profile-start-date'),       p.journeyStartDate);
    UI.setInputVal(document.getElementById('profile-starting-weight'),  p.startingWeightKg || '');
    UI.setInputVal(document.getElementById('profile-goal-weight'),      p.goalWeightKg || '');
    UI.setInputVal(document.getElementById('profile-weekly-goal-kg'),   p.weeklyGoalKg || '');

    // Populate coach fields
    const coach = p.coach || {};
    const coachEnabledEl  = document.getElementById('coach-enabled');
    const coachFieldsWrap = document.getElementById('coach-fields-wrap');
    coachEnabledEl.checked = !!coach.enabled;
    UI.setInputVal(document.getElementById('coach-name'),               coach.name || '');
    document.getElementById('coach-checkin-day').value = coach.checkInDay || 'thursday';
    UI.setInputVal(document.getElementById('coach-arrangement-notes'),  coach.arrangementNotes || '');

    // Show/hide coach fields section
    coachFieldsWrap.classList.toggle('hidden', !coach.enabled);

    // Bind toggle to show/hide coach fields
    coachEnabledEl.addEventListener('change', () => {
      coachFieldsWrap.classList.toggle('hidden', !coachEnabledEl.checked);
    });

    // Travel mode
    const travelCheck  = document.getElementById('travel-mode-enabled');
    const travelFields = document.getElementById('travel-mode-fields');
    const maintCalEl   = document.getElementById('maintenance-calories');
    if (travelCheck) {
      travelCheck.checked = !!p.travelMode;
      if (travelFields) travelFields.classList.toggle('hidden', !p.travelMode);
      if (maintCalEl) UI.setInputVal(maintCalEl, p.maintenanceCalories || '');
      travelCheck.addEventListener('change', () => {
        if (travelFields) travelFields.classList.toggle('hidden', !travelCheck.checked);
      });
    }

    // MVD Presets
    Profile._renderMVDPresets();
    const mvdSaveBtn = document.getElementById('mvd-save-btn');
    if (mvdSaveBtn) {
      const newMvdSave = mvdSaveBtn.cloneNode(true);
      mvdSaveBtn.parentNode.replaceChild(newMvdSave, mvdSaveBtn);
      newMvdSave.addEventListener('click', () => {
        const list = document.getElementById('mvd-presets-list');
        if (!list) return;
        const rows = list.querySelectorAll('.mvd-preset-row');
        State.profile.mvdPresets = [...rows].map(row => ({
          name:           row.querySelector('.mvd-name').value.trim(),
          caloriesTarget: row.querySelector('.mvd-cal').value  !== '' ? parseInt(row.querySelector('.mvd-cal').value)  : null,
          proteinTarget:  row.querySelector('.mvd-prot').value !== '' ? parseInt(row.querySelector('.mvd-prot').value) : null,
          stepsTarget:    row.querySelector('.mvd-steps').value !== '' ? parseInt(row.querySelector('.mvd-steps').value) : null
        }));
        Storage.save();
        UI.showToast('Presets saved!', 'success');
      });
    }
  },

  _renderMVDPresets() {
    const list = document.getElementById('mvd-presets-list');
    if (!list) return;
    const presets = State.profile.mvdPresets || [{},{},{}];
    list.innerHTML = '';
    presets.forEach((preset, i) => {
      const row = document.createElement('div');
      row.className = 'mvd-preset-row';
      row.innerHTML = `
        <div class="mvd-preset-label">Preset ${i + 1}</div>
        <div class="mvd-preset-fields">
          <input type="text"   class="mvd-name"  placeholder="Name (e.g. Travel day)" value="${preset.name || ''}">
          <input type="number" class="mvd-cal"   placeholder="Calories" min="0" max="9999" step="50"  value="${preset.caloriesTarget !== null && preset.caloriesTarget !== undefined ? preset.caloriesTarget : ''}">
          <input type="number" class="mvd-prot"  placeholder="Protein (g)" min="0" max="999" step="1" value="${preset.proteinTarget  !== null && preset.proteinTarget  !== undefined ? preset.proteinTarget  : ''}">
          <input type="number" class="mvd-steps" placeholder="Steps" min="0" max="99999" step="500"   value="${preset.stepsTarget    !== null && preset.stepsTarget    !== undefined ? preset.stepsTarget    : ''}">
        </div>
      `;
      list.appendChild(row);
    });
  },

  _updateStatCards() {
    const p = State.profile;
    const heightM = (p.heightCm || 0) / 100;

    const age = p.dob ? UI.calcAge(p.dob) : null;
    const days = p.journeyStartDate ? UI.dateDiffDays(p.journeyStartDate, UI.todayISO()) : null;

    const startBMI = (p.startingWeightKg && heightM > 0)
      ? (p.startingWeightKg / (heightM * heightM)).toFixed(1)
      : null;
    const goalBMI = (p.goalWeightKg && heightM > 0)
      ? (p.goalWeightKg / (heightM * heightM)).toFixed(1)
      : null;

    document.getElementById('profile-stat-age').textContent          = age  !== null ? age  : '—';
    document.getElementById('profile-stat-days').textContent         = days !== null ? days : '—';
    document.getElementById('profile-stat-start-bmi').textContent    = startBMI || '—';
    document.getElementById('profile-stat-start-bmi-cat').textContent = startBMI ? Computed.bmiCategory(parseFloat(startBMI)) : '';
    document.getElementById('profile-stat-goal-bmi').textContent     = goalBMI  || '—';
    document.getElementById('profile-stat-goal-bmi-cat').textContent  = goalBMI  ? Computed.bmiCategory(parseFloat(goalBMI))  : '';
  },

  handleSubmit(e) {
    e.preventDefault();
    const name    = document.getElementById('profile-name').value.trim();
    const dob     = document.getElementById('profile-dob').value;
    const height  = parseFloat(document.getElementById('profile-height').value);
    const start   = document.getElementById('profile-start-date').value;
    const startW  = parseFloat(document.getElementById('profile-starting-weight').value);
    const goalW   = parseFloat(document.getElementById('profile-goal-weight').value);
    const weeklyGoalKg = UI.numOrNull(document.getElementById('profile-weekly-goal-kg'));

    // Basic validation
    if (!name)    { UI.showToast('Name is required.', 'error'); return; }
    if (!dob)     { UI.showToast('Date of birth is required.', 'error'); return; }
    if (!height || height < 100 || height > 250) { UI.showToast('Please enter a valid height (100–250 cm).', 'error'); return; }
    if (!start)   { UI.showToast('Journey start date is required.', 'error'); return; }
    if (!startW || startW < 30 || startW > 400)  { UI.showToast('Please enter a valid starting weight.', 'error'); return; }
    if (!goalW  || goalW  < 30 || goalW  > 400)  { UI.showToast('Please enter a valid goal weight.', 'error'); return; }

    // Read coach data
    const coachEnabled = document.getElementById('coach-enabled').checked;
    const coachName    = document.getElementById('coach-name').value.trim();
    const coachDay     = document.getElementById('coach-checkin-day').value;
    const coachNotes   = document.getElementById('coach-arrangement-notes').value.trim();

    const travelEnabled = document.getElementById('travel-mode-enabled')?.checked || false;
    const maintCal = UI.numOrNull(document.getElementById('maintenance-calories'));

    State.profile = {
      name, dob, heightCm: height, journeyStartDate: start,
      startingWeightKg: startW, goalWeightKg: goalW,
      weeklyGoalKg: weeklyGoalKg,
      travelMode: travelEnabled,
      maintenanceCalories: maintCal,
      mvdPresets: State.profile.mvdPresets || [
        {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null},
        {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null},
        {name:'',caloriesTarget:null,proteinTarget:null,stepsTarget:null}
      ],
      coach: {
        enabled:          coachEnabled,
        name:             coachName,
        checkInDay:       coachDay,
        arrangementNotes: coachNotes,
        questionsForCoach: State.profile.coach?.questionsForCoach || '',
        weeklyPlan: State.profile.coach?.weeklyPlan || {
          monday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          tuesday:   {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          wednesday: {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          thursday:  {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          friday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          saturday:  {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''},
          sunday:    {caloriesTarget:null,proteinTarget:null,fatTarget:null,carbsTarget:null,stepsTarget:null,training:''}
        }
      }
    };

    // Height change affects ALL BMI calculations — recompute everything
    Computed.recalculateAll();
    Storage.save();
    Profile._updateStatCards();
    Coach.updateNavVisibility();
    UI.showToast('Profile saved!', 'success');
  }
};

/* ============================================================
   PHOTOS — upload, gallery, side-by-side comparison
   Each submission is a session with Front, Side, and Back slots.
   Schema: { id, date, notes, front, side, back }
   ============================================================ */
const Photos = {
  render() {
    Photos._populateCompareSelects();
    Photos._renderGallery();

    // Wire up per-angle file inputs to show preview images
    ['front', 'side', 'back'].forEach(angle => {
      const input   = document.getElementById(`photo-${angle}-input`);
      const preview = document.getElementById(`photo-preview-${angle}`);
      if (!input || !preview) return;
      const newInput = input.cloneNode(true);
      input.parentNode.replaceChild(newInput, input);
      newInput.addEventListener('change', () => {
        const file = newInput.files[0];
        if (file) {
          const url = URL.createObjectURL(file);
          preview.src = url;
          preview.classList.remove('hidden');
        } else {
          preview.src = '';
          preview.classList.add('hidden');
        }
      });
    });

    // Default upload date to today
    const uploadDate = document.getElementById('photo-upload-date');
    if (!uploadDate.value) uploadDate.value = UI.todayISO();

    // Upload button
    const uploadBtn = document.getElementById('photo-upload-btn');
    const newUploadBtn = uploadBtn.cloneNode(true);
    uploadBtn.parentNode.replaceChild(newUploadBtn, uploadBtn);
    newUploadBtn.addEventListener('click', Photos.handleUpload);

    // Compare button
    const compareBtn = document.getElementById('compare-btn');
    const newCompareBtn = compareBtn.cloneNode(true);
    compareBtn.parentNode.replaceChild(newCompareBtn, compareBtn);
    newCompareBtn.addEventListener('click', Photos.handleCompare);
  },

  /** Compress and store a photo session (front + side + back). */
  async handleUpload() {
    const frontFile = (document.getElementById('photo-front-input').files[0]) || null;
    const sideFile  = (document.getElementById('photo-side-input').files[0])  || null;
    const backFile  = (document.getElementById('photo-back-input').files[0])  || null;

    if (!frontFile && !sideFile && !backFile) {
      UI.showToast('Please choose at least one photo.', 'error');
      return;
    }

    for (const [label, file] of [['Front', frontFile], ['Side', sideFile], ['Back', backFile]]) {
      if (file && !file.type.startsWith('image/')) {
        UI.showToast(`${label} photo must be an image file.`, 'error');
        return;
      }
    }

    const date  = document.getElementById('photo-upload-date').value || UI.todayISO();
    const notes = document.getElementById('photo-session-notes').value.trim() || '';

    try {
      const compress = async (file) => file ? await Photos._compressImage(file) : null;
      const [front, side, back] = await Promise.all([
        compress(frontFile),
        compress(sideFile),
        compress(backFile)
      ]);

      const session = {
        id:    `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        date,
        notes,
        front,
        side,
        back
      };
      State.photos.push(session);
      Storage.save();

      // Reset upload area
      ['front', 'side', 'back'].forEach(angle => {
        const input   = document.getElementById(`photo-${angle}-input`);
        const preview = document.getElementById(`photo-preview-${angle}`);
        if (input)   input.value = '';
        if (preview) { preview.src = ''; preview.classList.add('hidden'); }
      });
      document.getElementById('photo-session-notes').value = '';

      UI.showToast('Photo session uploaded!', 'success');
      Photos._renderGallery();
      Photos._populateCompareSelects();
    } catch (err) {
      UI.showToast('Failed to process image.', 'error');
      console.error('handleUpload error:', err);
    }
  },

  /**
   * Resize and compress an image using an offscreen canvas.
   * @param {File} file
   * @param {number} maxWidth — max output width in pixels
   * @param {number} quality — JPEG quality (0–1)
   * @returns {Promise<string>} — base64 data URL
   */
  /** Compress an image file to a base64 JPEG under maxBytes.
   *  Iteratively lowers quality (and then width) until the target is met. */
  _compressImage(file, maxWidth = 1600, quality = 0.85, maxBytes = 900_000) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        const ctx    = canvas.getContext('2d');

        const draw = (w, q) => {
          const scale = Math.min(1, w / img.width);
          canvas.width  = Math.round(img.width  * scale);
          canvas.height = Math.round(img.height * scale);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', q);
        };

        // Step 1: try reducing quality in steps until under limit
        let result = draw(maxWidth, quality);
        let q = quality;
        while (result.length > maxBytes && q > 0.3) {
          q = Math.max(0.3, q - 0.1);
          result = draw(maxWidth, q);
        }

        // Step 2: if still over limit, shrink dimensions too
        let w = maxWidth;
        while (result.length > maxBytes && w > 400) {
          w = Math.round(w * 0.75);
          result = draw(w, q);
        }

        resolve(result);
      };
      img.src = url;
    });
  },

  /** Populate the comparison dropdowns with all sessions. */
  _populateCompareSelects() {
    const sorted = [...State.photos].sort((a, b) => a.date.localeCompare(b.date));
    const buildOptions = (selectEl) => {
      const current = selectEl.value;
      selectEl.innerHTML = '<option value="">— Select a session —</option>';
      sorted.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${UI.formatDate(s.date)}${s.notes ? ' — ' + s.notes : ''}`;
        selectEl.appendChild(opt);
      });
      if (sorted.find(s => s.id === current)) selectEl.value = current;
    };
    buildOptions(document.getElementById('compare-photo-a'));
    buildOptions(document.getElementById('compare-photo-b'));
  },

  /** Show comparison view: 2 sessions × 3 angles grid. */
  handleCompare() {
    const idA = document.getElementById('compare-photo-a').value;
    const idB = document.getElementById('compare-photo-b').value;
    if (!idA || !idB) {
      UI.showToast('Please select two sessions to compare.', 'error');
      return;
    }
    const sessA = State.photos.find(p => p.id === idA);
    const sessB = State.photos.find(p => p.id === idB);
    if (!sessA || !sessB) return;

    document.getElementById('compare-label-a').textContent =
      `${UI.formatDate(sessA.date)}${sessA.notes ? ' — ' + sessA.notes : ''}`;
    document.getElementById('compare-label-b').textContent =
      `${UI.formatDate(sessB.date)}${sessB.notes ? ' — ' + sessB.notes : ''}`;

    const setImg = (id, src) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (src) {
        el.src = src;
        el.classList.remove('hidden');
      } else {
        el.src = '';
        el.classList.add('hidden');
      }
    };

    setImg('compare-front-a', sessA.front);
    setImg('compare-front-b', sessB.front);
    setImg('compare-side-a',  sessA.side);
    setImg('compare-side-b',  sessB.side);
    setImg('compare-back-a',  sessA.back);
    setImg('compare-back-b',  sessB.back);

    document.getElementById('comparison-view').classList.remove('hidden');
    document.getElementById('comparison-view').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  /** Render the photo gallery as session cards with 3 thumbnails each. */
  _renderGallery() {
    const gallery = document.getElementById('photos-gallery');
    const empty   = document.getElementById('photos-empty');
    gallery.innerHTML = '';

    if (State.photos.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    const sorted = [...State.photos].sort((a, b) => b.date.localeCompare(a.date));

    sorted.forEach(session => {
      const card = document.createElement('div');
      card.className = 'photo-session-card';

      const thumbs = ['front', 'side', 'back'].map(angle => {
        const src = session[angle];
        const label = angle.charAt(0).toUpperCase() + angle.slice(1);
        return `
          <div class="thumb-slot">
            <span>${label}</span>
            ${src
              ? `<img src="${src}" alt="${label}" loading="lazy">`
              : `<div class="thumb-slot-empty">—</div>`}
          </div>`;
      }).join('');

      card.innerHTML = `
        <div class="photo-session-date">${UI.formatDate(session.date)}</div>
        ${session.notes ? `<div class="photo-session-notes">${session.notes}</div>` : ''}
        <div class="photo-session-thumbs">${thumbs}</div>
        <button class="photo-session-delete" data-id="${session.id}">Remove Session</button>
      `;
      gallery.appendChild(card);
    });

    gallery.querySelectorAll('.photo-session-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Remove this photo session? This cannot be undone.')) {
          const idx = State.photos.findIndex(p => p.id === btn.dataset.id);
          if (idx !== -1) {
            State.photos.splice(idx, 1);
            Storage.save();
            Photos._renderGallery();
            Photos._populateCompareSelects();
            document.getElementById('comparison-view').classList.add('hidden');
            UI.showToast('Photo session removed.', 'info');
          }
        }
      });
    });
  }
};

/* ============================================================
   COACH PAGE — full check-in history with per-period metrics
   ============================================================ */
const CoachPage = {
  render() {
    const coach = State.profile.coach || {};
    const coachName = coach.name || 'your coach';
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const checkInDayName = days[Coach.getCheckInDayIndex()];

    document.getElementById('coach-page-subtitle').textContent =
      `${coachName} · Check-in day: ${checkInDayName}s`;

    // Next check-in date badge
    const nextDate = CoachPage._getNextCheckInDate();
    document.getElementById('coach-next-checkin-date').textContent =
      nextDate ? `Next: ${UI.formatDate(nextDate)}` : '';

    // Populate questions textarea
    document.getElementById('coach-questions-textarea').value =
      coach.questionsForCoach || '';

    // Save questions button (clone to remove stale listeners)
    const saveBtn = document.getElementById('coach-questions-save-btn');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener('click', () => {
      if (!State.profile.coach) return;
      State.profile.coach.questionsForCoach =
        document.getElementById('coach-questions-textarea').value.trim();
      Storage.save();
      UI.showToast('Questions saved!', 'success');
    });

    CoachPage._renderWeeklyPlan();
    CoachPage._renderHistory();
  },

  _renderWeeklyPlan() {
    const tbody = document.getElementById('weekly-plan-tbody');
    if (!tbody) return;
    const dayNames = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    const plan = State.profile.coach?.weeklyPlan || {};
    tbody.innerHTML = '';
    dayNames.forEach(day => {
      const d = plan[day] || { caloriesTarget: null, proteinTarget: null, fatTarget: null, carbsTarget: null, stepsTarget: null, training: '' };
      const tr = document.createElement('tr');
      tr.dataset.day = day;
      tr.innerHTML = `
        <td class="weekly-plan-day">${day.charAt(0).toUpperCase() + day.slice(1)}</td>
        <td><input type="number" class="wp-calories" min="0" max="9999" step="50"  value="${d.caloriesTarget !== null && d.caloriesTarget !== undefined ? d.caloriesTarget : ''}" placeholder="—"></td>
        <td><input type="number" class="wp-protein"  min="0" max="999"  step="1"   value="${d.proteinTarget  !== null && d.proteinTarget  !== undefined ? d.proteinTarget  : ''}" placeholder="—"></td>
        <td><input type="number" class="wp-fat"      min="0" max="999"  step="1"   value="${d.fatTarget      !== null && d.fatTarget      !== undefined ? d.fatTarget      : ''}" placeholder="—"></td>
        <td><input type="number" class="wp-carbs"    min="0" max="999"  step="1"   value="${d.carbsTarget    !== null && d.carbsTarget    !== undefined ? d.carbsTarget    : ''}" placeholder="—"></td>
        <td><input type="number" class="wp-steps"    min="0" max="99999" step="500" value="${d.stepsTarget  !== null && d.stepsTarget    !== undefined ? d.stepsTarget    : ''}" placeholder="—"></td>
        <td><input type="text"   class="wp-training" maxlength="40"      value="${d.training || ''}" placeholder="e.g. Leg day"></td>
      `;
      tbody.appendChild(tr);
    });

    // Save button
    const saveBtn = document.getElementById('weekly-plan-save-btn');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener('click', () => {
      if (!State.profile.coach) return;
      const newPlan = {};
      tbody.querySelectorAll('tr[data-day]').forEach(tr => {
        const day   = tr.dataset.day;
        const cal   = tr.querySelector('.wp-calories').value;
        const prot  = tr.querySelector('.wp-protein').value;
        const fat   = tr.querySelector('.wp-fat').value;
        const carbs = tr.querySelector('.wp-carbs').value;
        const step  = tr.querySelector('.wp-steps').value;
        const train = tr.querySelector('.wp-training').value.trim();
        newPlan[day] = {
          caloriesTarget: cal   !== '' ? parseInt(cal)   : null,
          proteinTarget:  prot  !== '' ? parseInt(prot)  : null,
          fatTarget:      fat   !== '' ? parseInt(fat)   : null,
          carbsTarget:    carbs !== '' ? parseInt(carbs) : null,
          stepsTarget:    step  !== '' ? parseInt(step)  : null,
          training: train
        };
      });
      State.profile.coach.weeklyPlan = newPlan;
      Storage.save();
      UI.showToast('Weekly plan saved!', 'success');
    });
  },

  /** ISO date of the next (or current) check-in day, at or after today. */
  _getNextCheckInDate() {
    const today = UI.todayISO();
    const [y, m, d] = today.split('-').map(Number);
    const target = Coach.getCheckInDayIndex();
    for (let i = 0; i <= 7; i++) {
      const dt = new Date(y, m - 1, d + i);
      if (dt.getDay() === target) {
        return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
      }
    }
    return null;
  },

  /** All past check-in dates from journey start to today, newest first. */
  _getAllCheckInDates() {
    const start = State.profile.journeyStartDate;
    const today = UI.todayISO();
    if (!start) return [];

    const target = Coach.getCheckInDayIndex();
    const result = [];
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ty, tm, td] = today.split('-').map(Number);
    let dt = new Date(sy, sm - 1, sd);
    const end = new Date(ty, tm - 1, td);

    while (dt <= end) {
      if (dt.getDay() === target) {
        const yy = dt.getFullYear();
        const mm = String(dt.getMonth()+1).padStart(2,'0');
        const dd = String(dt.getDate()).padStart(2,'0');
        result.push(`${yy}-${mm}-${dd}`);
      }
      dt = new Date(dt.getTime() + 86400000);
    }
    return result.reverse(); // newest first
  },

  /** Aggregate metrics for the period leading up to checkInDate. */
  _getPeriodMetrics(checkInDate, prevCheckInDate) {
    // Period start: day after previous check-in (or journey start)
    let periodStart;
    if (prevCheckInDate) {
      const [y, m, d] = prevCheckInDate.split('-').map(Number);
      const next = new Date(y, m - 1, d + 1);
      periodStart = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}`;
    } else {
      periodStart = State.profile.journeyStartDate || checkInDate;
    }

    const entries = Entries.getSorted().filter(
      e => e.date >= periodStart && e.date <= checkInDate
    );

    if (entries.length === 0) return { periodStart, periodEnd: checkInDate, dayCount: UI.dateDiffDays(periodStart, checkInDate) + 1, entryCount: 0 };

    const withWeight   = entries.filter(e => e.weightKg);
    const withCalories = entries.filter(e => e.caloriesKcal !== null);
    const withProtein  = entries.filter(e => e.proteinG  !== null);
    const withCarbs    = entries.filter(e => e.carbsG    !== null);
    const withFat      = entries.filter(e => e.fatG      !== null);
    const withSteps    = entries.filter(e => e.stepsCount !== null && e.stepsCount !== undefined);

    const avg = (arr, key) => arr.length
      ? Math.round(arr.reduce((s, e) => s + e[key], 0) / arr.length)
      : null;

    const weightChange = withWeight.length >= 2
      ? parseFloat((withWeight[withWeight.length-1].weightKg - withWeight[0].weightKg).toFixed(2))
      : null;

    const totalSteps = withSteps.length
      ? withSteps.reduce((s, e) => s + e.stepsCount, 0)
      : null;

    const nsvsInPeriod = entries
      .filter(e => e.nsv && e.nsv.trim())
      .map(e => ({ date: e.date, nsv: e.nsv.trim() }));

    // Coach notes recorded on the check-in day itself
    const checkInEntry = entries.find(e => e.date === checkInDate);
    const coachNotes = checkInEntry?.coachNotes || null;

    // Photo sessions in this period
    const photosInPeriod = State.photos.filter(
      p => p.date >= periodStart && p.date <= checkInDate
    );

    return {
      periodStart,
      periodEnd:   checkInDate,
      dayCount:    UI.dateDiffDays(periodStart, checkInDate) + 1,
      entryCount:  entries.length,
      weightChange,
      startWeight: withWeight.length ? withWeight[0].weightKg : null,
      endWeight:   withWeight.length ? withWeight[withWeight.length-1].weightKg : null,
      avgCalories: avg(withCalories, 'caloriesKcal'),
      avgProtein:  avg(withProtein, 'proteinG'),
      avgCarbs:    avg(withCarbs, 'carbsG'),
      avgFat:      avg(withFat, 'fatG'),
      totalSteps,
      avgSteps:    withSteps.length ? Math.round(totalSteps / withSteps.length) : null,
      nsvsInPeriod,
      coachNotes,
      photosInPeriod
    };
  },

  _renderHistory() {
    const list  = document.getElementById('coach-history-list');
    const empty = document.getElementById('coach-history-empty');
    list.innerHTML = '';

    const checkIns = CoachPage._getAllCheckInDates();

    if (checkIns.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    checkIns.forEach((date, i) => {
      // array is newest-first, so the previous check-in is index i+1
      const prevDate = checkIns[i + 1] || null;
      const m = CoachPage._getPeriodMetrics(date, prevDate);

      const card = document.createElement('div');
      card.className = 'coach-history-card';

      // Weight change cell (colour-coded)
      let weightChangeHtml = '—';
      if (m.weightChange !== null) {
        if (m.weightChange < 0) {
          weightChangeHtml = `<span class="metric-positive">&#8722;${Math.abs(m.weightChange).toFixed(1)} kg</span>`;
        } else if (m.weightChange > 0) {
          weightChangeHtml = `<span class="metric-negative">+${m.weightChange.toFixed(1)} kg</span>`;
        } else {
          weightChangeHtml = '0.0 kg';
        }
      }

      // Helper: render one metric tile, skipping nulls
      const tile = (label, value, unit = '') => {
        if (value === null || value === undefined) return '';
        const unitSpan = unit ? ` <span class="coach-metric-unit">${unit}</span>` : '';
        return `<div class="coach-metric">
          <span class="coach-metric-label">${label}</span>
          <span class="coach-metric-value">${value}${unitSpan}</span>
        </div>`;
      };

      // NSVs section
      const nsvsHtml = m.nsvsInPeriod?.length
        ? `<div class="coach-history-section coach-history-nsvs">
            <div class="coach-history-section-title">Non-Scale Victories</div>
            <ul>${m.nsvsInPeriod.map(n =>
              `<li><span class="coach-nsv-date">${UI.formatDate(n.date)}</span> ${n.nsv}</li>`
            ).join('')}</ul>
          </div>`
        : '';

      // Coach notes section
      const notesHtml = m.coachNotes
        ? `<div class="coach-history-section">
            <div class="coach-history-section-title">Coach Notes</div>
            <div class="coach-history-notes-text">${m.coachNotes}</div>
          </div>`
        : '';

      // Photos badge
      const photosHtml = m.photosInPeriod?.length
        ? `<div class="coach-history-section">
            <button class="coach-photos-badge" data-goto="photos">
              &#128247; ${m.photosInPeriod.length} progress session${m.photosInPeriod.length > 1 ? 's' : ''} available &rarr; View Photos
            </button>
          </div>`
        : '';

      card.innerHTML = `
        <div class="coach-history-header">
          <div class="coach-history-date">${UI.formatDate(date)}</div>
          <div class="coach-history-period">${m.dayCount}-day period &middot; ${m.entryCount} weigh-in${m.entryCount !== 1 ? 's' : ''} logged</div>
        </div>
        <div class="coach-metrics-grid">
          <div class="coach-metric coach-metric-highlight">
            <span class="coach-metric-label">Weight change</span>
            <span class="coach-metric-value">${weightChangeHtml}</span>
          </div>
          ${tile('Start weight', m.startWeight !== null ? m.startWeight.toFixed(1) : null, 'kg')}
          ${tile('End weight',   m.endWeight   !== null ? m.endWeight.toFixed(1)   : null, 'kg')}
          ${tile('Avg daily steps', m.avgSteps !== null ? m.avgSteps.toLocaleString() : null)}
          ${tile('Total steps',    m.totalSteps !== null ? m.totalSteps.toLocaleString() : null)}
          ${tile('Avg calories', m.avgCalories, 'kcal')}
          ${tile('Avg protein',  m.avgProtein,  'g')}
          ${tile('Avg carbs',    m.avgCarbs,    'g')}
          ${tile('Avg fat',      m.avgFat,      'g')}
        </div>
        ${nsvsHtml}
        ${notesHtml}
        ${photosHtml}
      `;

      list.appendChild(card);
    });

    // Navigate to Photos page when badge is clicked
    list.querySelectorAll('[data-goto="photos"]').forEach(btn => {
      btn.addEventListener('click', () => Nav.goTo('photos'));
    });
  }
};

/* ============================================================
   AUTH — Firebase Authentication (Google Sign-In)
   ============================================================ */
const Auth = {
  /** Sign in with a Google popup. onAuthStateChanged handles the rest. */
  async signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await firebase.auth().signInWithPopup(provider);
    } catch (e) {
      console.error('Sign-in error:', e);
      UI.showToast('Sign-in failed. Please try again.', 'error');
    }
  },

  /** Sign out. onAuthStateChanged hides the app and shows login. */
  async signOut() {
    await firebase.auth().signOut();
  },

  /** Show the full-screen login overlay. */
  showLoginScreen() {
    document.getElementById('auth-overlay').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  },

  /** Hide the login overlay. */
  hideLoginScreen() {
    document.getElementById('auth-overlay').classList.add('hidden');
  },

  /** Update the nav user display with name and avatar. */
  updateNavUI(user) {
    const avatarEl = document.getElementById('nav-user-avatar');
    const nameEl   = document.getElementById('nav-user-name');
    if (user) {
      const firstName = user.displayName ? user.displayName.split(' ')[0] : (user.email || '');
      nameEl.textContent = firstName;
      if (user.photoURL) {
        avatarEl.src = user.photoURL;
        avatarEl.classList.remove('hidden');
      } else {
        avatarEl.classList.add('hidden');
      }
    } else {
      nameEl.textContent = '';
      avatarEl.classList.add('hidden');
    }
  }
};

/* ============================================================
   APP — bootstrap and initialization
   ============================================================ */
const App = {
  /** Called after wizard or import prompt resolves. Starts the main app. */
  start() {
    document.getElementById('app').classList.remove('hidden');
    Nav.init();
    Coach.updateNavVisibility();
    Nav.goTo('dashboard');
  },

  /** Main entry point — called on DOMContentLoaded. */
  init() {
    // Apply Chart.js dark defaults before any chart is created
    Charts.applyDefaults();

    // Show login screen until Firebase confirms auth state
    Auth.showLoginScreen();

    // Firebase auth state observer — fires immediately on page load
    firebase.auth().onAuthStateChanged(async (user) => {
      if (user) {
        // User is signed in — load their data from Firestore
        Auth.hideLoginScreen();
        Auth.updateNavUI(user);
        await Storage.load();
        if (Storage.isFirstLaunch()) {
          Wizard.show();
        } else {
          App.start();
        }
      } else {
        // User is signed out — show login screen and clear data
        Auth.showLoginScreen();
        Auth.updateNavUI(null);
        // Wipe state so stale data is never shown if another account signs in later
        State.entries = [];
        State.photos  = [];
        State.profile.name = ''; // enough for isFirstLaunch() to work if re-used
      }
    });
  }
};

/* ============================================================
   BOOTSTRAP — wait for DOM then start
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
