(function () {
  'use strict';

  const STORAGE_KEY = 'budgetAppState';
  const BUDGET_SPLIT = { needs: 0.50, wants: 0.30, savings: 0.20 };
  const PIE_COLORS = ['#8698B0','#b0a0c5','#7fb89a','#c9a96e','#c9946e','#d4726a','#6fb8a8','#8698c5'];

  // --- Utilities ---
  function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function sanitize(str) { const el = document.createElement('span'); el.textContent = str; return el.innerHTML; }
  function formatCurrency(n) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n); }
  function roundCents(n) { return Math.round(n * 100) / 100; }
  function formatDate(iso) { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  function formatDateLong(iso) { return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
  function formatDateFull(date) { return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
  function daysBetween(a, b) {
    var da = new Date(a); da.setHours(0,0,0,0);
    var db = new Date(b); db.setHours(0,0,0,0);
    return Math.round((db - da) / 86400000);
  }
  function toDateString(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  function today() { return toDateString(new Date()); }
  function daysUntil(dateStr) {
    const now = new Date(); now.setHours(0,0,0,0);
    const target = new Date(dateStr + 'T00:00:00'); target.setHours(0,0,0,0);
    return Math.ceil((target - now) / 86400000);
  }

  // --- Default State ---
  function getDefaultState() {
    return {
      onboardingComplete: false,
      bankBalance: 0,
      extraMoney: 0,
      biWeeklyIncome: 0,
      lockPercent: 20,
      payCycleDays: 14,
      nextPayday: null,       // 'YYYY-MM-DD'
      totalLockedSavings: 0,
      _pendingCashIn: 0,
      firstCycleStarted: false,
      cycle: {
        active: false, startDate: null, endDate: null,
        initialIncome: 0, lockPercent: 20, hiddenSavings: 0,
        spendableBalance: 0,
        categoryBudgets: { needs: 0, wants: 0, savings: 0 },
        categorySpent: { needs: 0, wants: 0, savings: 0 },
        expenses: [],
        billsPaidThisCycle: []
      },
      goals: [],
      pendingGoals: [],
      bills: [],
      history: [],
      _lastReport: null
    };
  }

  // --- State ---
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        const d = getDefaultState();
        return {
          ...d, ...p,
          cycle: { ...d.cycle, ...p.cycle },
          bills: p.bills || [],
          pendingGoals: p.pendingGoals || [],
          totalLockedSavings: p.totalLockedSavings || 0,
          _pendingCashIn: p._pendingCashIn || 0,
          onboardingComplete: p.onboardingComplete || false,
          bankBalance: p.bankBalance || 0,
          extraMoney: p.extraMoney || 0,
          payCycleDays: p.payCycleDays || 14,
          nextPayday: p.nextPayday || null,
          firstCycleStarted: p.firstCycleStarted || (p.history && p.history.length > 0) || (p.cycle && p.cycle.active) || false
        };
      }
    } catch (e) { console.warn('Load failed:', e); }
    return getDefaultState();
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.error('Save failed:', e); }
  }

  let state = loadState();
  let currentTab = 'main';
  let pendingFallbackDeposit = null;
  let clockInterval = null;
  let onboardPath = null; // 'just-paid' or 'waiting'

  // --- Onboarding ---
  function showOnboarding() {
    document.getElementById('onboarding').classList.remove('hidden');
    document.getElementById('main-app').classList.add('hidden');
    // Set min date on payday picker to today
    const payInput = document.getElementById('onboard-payday');
    if (payInput) payInput.min = today();
  }

  function hideOnboarding() {
    document.getElementById('onboarding').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
  }

  function showOnboardStep(stepId) {
    ['onboard-welcome','onboard-path','onboard-step1','onboard-step2','onboard-step3','onboard-step4'].forEach(id => {
      document.getElementById(id).classList.add('hidden');
    });
    document.getElementById(stepId).classList.remove('hidden');
  }

  function computeRecommendedLock(bankBalance, extraMoney, daysToPayday, income) {
    const totalAvailable = bankBalance + extraMoney;
    // If they have very little relative to income, recommend lower lock
    // If they have lots of cushion, recommend higher lock
    const cushionRatio = totalAvailable / (income || 1);
    let rec;
    if (cushionRatio < 0.5) rec = 10;
    else if (cushionRatio < 1) rec = 15;
    else if (cushionRatio < 2) rec = 20;
    else if (cushionRatio < 3) rec = 25;
    else rec = 30;
    return rec;
  }

  function renderOnboardRecommendation() {
    const bank = state.bankBalance;
    const extra = state.extraMoney;
    const total = roundCents(bank + extra);
    const income = state.biWeeklyIncome;
    const payday = state.nextPayday;
    const days = payday ? Math.max(0, daysUntil(payday)) : 0;
    const lockPct = parseInt(document.getElementById('onboard-lock-slider').value);
    const locked = roundCents(income * lockPct / 100);
    const spendable = roundCents(income - locked);
    const totalSpendable = onboardPath === 'waiting' ? roundCents(spendable + total) : roundCents(spendable + extra);

    const rec = document.getElementById('onboard-recommendation');

    if (onboardPath === 'just-paid') {
      // Simple summary for just-paid path
      rec.innerHTML = `
        <div class="onboard-summary">
          <div class="onboard-row"><span class="label">Paycheck</span><span class="value">${formatCurrency(income)}</span></div>
          ${extra > 0 ? `<div class="onboard-row"><span class="label">Extra Money</span><span class="value">${formatCurrency(extra)}</span></div>` : ''}
          <div class="onboard-row"><span class="label">Locked Away (${lockPct}%)</span><span class="value amber">${formatCurrency(locked)}</span></div>
          <div class="onboard-row"><span class="label">Spendable</span><span class="value green">${formatCurrency(totalSpendable)}</span></div>
        </div>
        <div class="onboard-recommendation-text">
          Your cycle starts now. <strong>${formatCurrency(locked)}</strong> is locked away as if it doesn't exist. You have <strong>${formatCurrency(totalSpendable)}</strong> to work with.
        </div>
      `;
    } else {
      // Waiting path — show bank info and daily budget
      const dailyNow = days > 0 ? roundCents(total / days) : total;
      rec.innerHTML = `
        <div class="onboard-summary">
          <div class="onboard-row"><span class="label">Bank Balance</span><span class="value">${formatCurrency(bank)}</span></div>
          ${extra > 0 ? `<div class="onboard-row"><span class="label">Extra Money</span><span class="value">${formatCurrency(extra)}</span></div>` : ''}
          <div class="onboard-row"><span class="label">Money You Have Now</span><span class="value green">${formatCurrency(total)}</span></div>
          <div class="onboard-row"><span class="label">Days to Payday</span><span class="value amber">${days} days</span></div>
          ${days > 0 ? `<div class="onboard-row"><span class="label">Daily Budget Until Then</span><span class="value rose">${formatCurrency(dailyNow)}/day</span></div>` : ''}
          <div class="onboard-row" style="border-top:2px solid var(--border);margin-top:0.25rem;padding-top:0.5rem"><span class="label">Paycheck</span><span class="value">${formatCurrency(income)}</span></div>
          <div class="onboard-row"><span class="label">Locked Away (${lockPct}%)</span><span class="value amber">${formatCurrency(locked)}</span></div>
          <div class="onboard-row"><span class="label">Spendable per Cycle</span><span class="value green">${formatCurrency(totalSpendable)}</span></div>
        </div>
        <div class="onboard-recommendation-text">
          ${days > 0
            ? `You have <strong>${formatCurrency(total)}</strong> to last you <strong>${days} days</strong> until payday. That's <strong>${formatCurrency(dailyNow)}/day</strong>. Be strict with yourself until then. Once your paycheck comes in, your <strong>${formatCurrency(total)}</strong> gets added to your spendable budget.`
            : `It's payday! Your cycle will start now with <strong>${formatCurrency(totalSpendable)}</strong> spendable and <strong>${formatCurrency(locked)}</strong> locked away.`
          }
        </div>
      `;
    }
  }

  function completeOnboarding() {
    state.onboardingComplete = true;
    saveState();
    hideOnboarding();

    if (onboardPath === 'just-paid') {
      // Just got paid — start cycle immediately
      startCycle(state.biWeeklyIncome, state.lockPercent);
    } else {
      const days = state.nextPayday ? daysUntil(state.nextPayday) : 0;
      if (days <= 0) {
        startCycle(state.biWeeklyIncome, state.lockPercent);
      }
    }
    render();
    startClock();
  }

  // --- Clock & Date ---
  function startClock() {
    updateDateDisplay();
    if (clockInterval) clearInterval(clockInterval);
    // Update every minute
    clockInterval = setInterval(updateDateDisplay, 60000);
  }

  function updateDateDisplay() {
    const dateEl = document.getElementById('current-date');
    const paydayEl = document.getElementById('next-payday-display');
    if (!dateEl) return;

    dateEl.textContent = formatDateFull(new Date());

    if (state.nextPayday) {
      const days = daysUntil(state.nextPayday);
      if (days > 0 && !state.cycle.active) {
        paydayEl.textContent = 'Payday in ' + days + ' day' + (days !== 1 ? 's' : '');
      } else if (days <= 0 && !state.cycle.active && !state._lastReport) {
        paydayEl.textContent = "It's payday!";
        // Auto-trigger payday if not in a cycle
        checkPaydayArrival();
      } else if (state.cycle.active) {
        const endDays = Math.max(0, daysBetween(new Date().toISOString(), state.cycle.endDate));
        paydayEl.textContent = endDays + ' day' + (endDays !== 1 ? 's' : '') + ' left in cycle';
      } else {
        paydayEl.textContent = '';
      }
    } else {
      paydayEl.textContent = '';
    }
  }

  function checkPaydayArrival() {
    if (!state.nextPayday || state.cycle.active || state._lastReport) return;
    const days = daysUntil(state.nextPayday);
    if (days <= 0) {
      // Payday has arrived — show the start cycle view with income pre-filled
      render();
    }
  }

  function advancePayday() {
    // Move nextPayday forward by payCycleDays
    if (state.nextPayday) {
      const d = new Date(state.nextPayday + 'T00:00:00');
      d.setDate(d.getDate() + state.payCycleDays);
      state.nextPayday = toDateString(d);
    }
  }

  // --- Tab Navigation ---
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById('tab-' + tab);
    if (target) target.classList.remove('hidden');
  }

  // --- Cycle ---
  function startCycle(income, lockPct) {
    state.biWeeklyIncome = income;
    state.lockPercent = lockPct;

    const locked = roundCents(income * lockPct / 100);
    let spendable = roundCents(income - locked);

    // On the very first cycle, add existing bank+extra to spendable (not locked)
    if (!state.firstCycleStarted) {
      if (state.bankBalance > 0 || state.extraMoney > 0) {
        const existingMoney = roundCents(state.bankBalance + state.extraMoney);
        spendable = roundCents(spendable + existingMoney);
      }
      state.firstCycleStarted = true;
    }

    // Apply any pending cash-in from previous cycle
    if (state._pendingCashIn > 0) {
      spendable = roundCents(spendable + state._pendingCashIn);
      state._pendingCashIn = 0;
    }

    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + state.payCycleDays);

    state.cycle = {
      active: true,
      startDate: now.toISOString(), endDate: end.toISOString(),
      initialIncome: income, lockPercent: lockPct,
      hiddenSavings: locked, spendableBalance: spendable,
      categoryBudgets: {
        needs: roundCents(spendable * BUDGET_SPLIT.needs),
        wants: roundCents(spendable * BUDGET_SPLIT.wants),
        savings: roundCents(spendable * BUDGET_SPLIT.savings)
      },
      categorySpent: { needs: 0, wants: 0, savings: 0 },
      expenses: [],
      billsPaidThisCycle: []
    };

    // Activate pending goals
    for (const pg of state.pendingGoals) state.goals.push(pg);
    state.pendingGoals = [];

    // Advance payday to next occurrence
    advancePayday();

    saveState();
    document.getElementById('tab-nav').classList.remove('hidden');
    render();
    updateDateDisplay();
  }

  function updateIncome(newIncome, newLockPct, newPayday, newFrequency) {
    state.biWeeklyIncome = newIncome;
    state.lockPercent = newLockPct;
    if (newPayday) state.nextPayday = newPayday;
    if (newFrequency) state.payCycleDays = parseInt(newFrequency);

    if (state.cycle.active) {
      const newLocked = roundCents(newIncome * newLockPct / 100);
      const newSpendable = roundCents(newIncome - newLocked);
      const totalSpent = roundCents(state.cycle.categorySpent.needs + state.cycle.categorySpent.wants + state.cycle.categorySpent.savings);
      state.cycle.initialIncome = newIncome;
      state.cycle.lockPercent = newLockPct;
      state.cycle.hiddenSavings = newLocked;
      state.cycle.spendableBalance = roundCents(newSpendable - totalSpent);
      state.cycle.categoryBudgets = {
        needs: roundCents(newSpendable * BUDGET_SPLIT.needs),
        wants: roundCents(newSpendable * BUDGET_SPLIT.wants),
        savings: roundCents(newSpendable * BUDGET_SPLIT.savings)
      };
    }
    saveState(); render(); updateDateDisplay();
  }

  function getCycleDays() { return state.payCycleDays || 14; }
  function getDaysRemaining() { return state.cycle.active ? Math.max(0, daysBetween(new Date().toISOString(), state.cycle.endDate)) : 0; }
  function getDaysElapsed() { return state.cycle.active ? Math.min(getCycleDays(), Math.max(0, daysBetween(state.cycle.startDate, new Date().toISOString()))) : 0; }

  function checkCycleExpiry() {
    if (state.cycle.active && new Date() >= new Date(state.cycle.endDate)) endCycle();
  }

  function endCycle() {
    const c = state.cycle;
    const totalSpent = roundCents(c.categorySpent.needs + c.categorySpent.wants + c.categorySpent.savings);
    const originalSpendable = roundCents(c.initialIncome - c.hiddenSavings);
    const leftover = roundCents(originalSpendable - totalSpent);
    const leftoverSaved = Math.max(0, leftover);

    allocateSavingsToGoals(leftoverSaved);

    // Accumulate locked money in the vault
    state.totalLockedSavings = roundCents(state.totalLockedSavings + c.hiddenSavings);

    const totalSaved = roundCents(c.hiddenSavings + leftoverSaved);
    const grade = computeGrade(totalSpent, originalSpendable);

    // Determine trend
    let trend = 'same';
    if (state.history.length > 0) {
      const prev = state.history[state.history.length - 1];
      if (totalSaved > prev.totalSaved) trend = 'up';
      else if (totalSaved < prev.totalSaved) trend = 'down';
    }

    state.history.push({
      startDate: c.startDate, endDate: c.endDate, initialIncome: c.initialIncome,
      totalSpent, totalSaved, grade: grade.letter, expenseCount: c.expenses.length,
      totalLockedSavings: state.totalLockedSavings
    });

    state._lastReport = {
      startDate: c.startDate, endDate: c.endDate, initialIncome: c.initialIncome,
      hiddenSavings: c.hiddenSavings, totalSpent, leftover: leftoverSaved, totalSaved,
      grade, trend, totalLockedSavings: state.totalLockedSavings,
      categorySpent: { ...c.categorySpent }, categoryBudgets: { ...c.categoryBudgets }
    };

    state.cycle.active = false;
    saveState(); render(); updateDateDisplay();
  }

  function computeGrade(spent, budget) {
    if (budget === 0) return { letter: 'A+', message: 'No budget, no problems.', class: 'grade-a' };
    const pct = (spent / budget) * 100;
    if (pct <= 50) return { letter: 'A+', message: 'Exceptional discipline. You crushed it.', class: 'grade-a' };
    if (pct <= 65) return { letter: 'A', message: 'Strong restraint. Keep this up.', class: 'grade-a' };
    if (pct <= 75) return { letter: 'B', message: 'Decent, but you can do better.', class: 'grade-b' };
    if (pct <= 85) return { letter: 'C', message: 'Cutting it close. Tighten up.', class: 'grade-c' };
    if (pct <= 95) return { letter: 'D', message: 'Barely made it. Do better next time.', class: 'grade-d' };
    return { letter: 'F', message: 'You need to seriously reconsider your spending.', class: 'grade-f' };
  }

  // --- Expenses ---
  function addExpense(amount, description, category) {
    const c = state.cycle;
    if (!c.active) return false;
    if (amount > c.spendableBalance) {
      showWarning('overspend', { attempted: amount, available: c.spendableBalance });
      return false;
    }
    const catBudget = c.categoryBudgets[category];
    const catSpent = c.categorySpent[category];
    if (amount > roundCents(catBudget - catSpent)) {
      showWarning('category-over', { category, attempted: amount, available: roundCents(catBudget - catSpent) });
    }
    if (amount > c.spendableBalance * 0.5 && c.spendableBalance > 0) {
      showWarning('caution', { amount, remaining: c.spendableBalance });
    }
    c.expenses.unshift({ id: generateId(), amount: roundCents(amount), description: description.trim(), category, date: new Date().toISOString() });
    c.spendableBalance = roundCents(c.spendableBalance - amount);
    c.categorySpent[category] = roundCents(c.categorySpent[category] + amount);
    saveState(); render();
    const origSpendable = roundCents(c.initialIncome - c.hiddenSavings);
    if (c.spendableBalance < origSpendable * 0.2 && c.spendableBalance > 0) {
      const dl = getDaysRemaining();
      showWarning('low-balance', { remaining: c.spendableBalance, daysLeft: dl, perDay: dl > 0 ? roundCents(c.spendableBalance / dl) : 0 });
    }
    return true;
  }

  function removeExpense(id) {
    const c = state.cycle;
    const idx = c.expenses.findIndex(e => e.id === id);
    if (idx === -1) return;
    const exp = c.expenses[idx];
    c.spendableBalance = roundCents(c.spendableBalance + exp.amount);
    c.categorySpent[exp.category] = roundCents(c.categorySpent[exp.category] - exp.amount);
    if (exp.billId) {
      c.billsPaidThisCycle = c.billsPaidThisCycle.filter(bid => bid !== exp.billId);
    }
    c.expenses.splice(idx, 1);
    saveState(); render();
  }

  // --- Bonus Money ---
  function addBonusMoney(amount, destination) {
    if (!state.cycle.active) return;
    const c = state.cycle;
    if (destination === 'lock') {
      c.hiddenSavings = roundCents(c.hiddenSavings + amount);
    } else {
      // Distribute across 50/30/20
      c.spendableBalance = roundCents(c.spendableBalance + amount);
      c.categoryBudgets.needs = roundCents(c.categoryBudgets.needs + amount * BUDGET_SPLIT.needs);
      c.categoryBudgets.wants = roundCents(c.categoryBudgets.wants + amount * BUDGET_SPLIT.wants);
      c.categoryBudgets.savings = roundCents(c.categoryBudgets.savings + amount * BUDGET_SPLIT.savings);
    }
    // Add to expense log as income entry
    c.expenses.unshift({
      id: generateId(),
      amount: roundCents(amount),
      description: destination === 'lock' ? 'Extra Money (Locked)' : 'Extra Money (50/30/20)',
      category: destination === 'lock' ? 'locked' : 'income',
      date: new Date().toISOString(),
      isIncome: true
    });
    saveState(); render();
  }

  // --- View Total Money ---
  function showTotalMoneyModal() {
    const c = state.cycle;
    const spendable = c.active ? c.spendableBalance : 0;
    const lockedThisCycle = c.active ? c.hiddenSavings : 0;
    const vaultTotal = state.totalLockedSavings + lockedThisCycle;
    const piggyTotal = state.goals.reduce(function(sum, g) { return roundCents(sum + g.savedAmount); }, 0);
    const grandTotal = roundCents(spendable + vaultTotal + piggyTotal);

    document.getElementById('total-money-breakdown').innerHTML =
      '<div class="total-row"><span class="label">Spendable Balance</span><span class="value" style="color:var(--accent-green)">' + formatCurrency(spendable) + '</span></div>' +
      '<div class="total-row"><span class="label">Locked This Cycle</span><span class="value" style="color:var(--accent-amber)">' + formatCurrency(lockedThisCycle) + '</span></div>' +
      '<div class="total-row"><span class="label">Vault (All Cycles)</span><span class="value" style="color:var(--accent-amber)">' + formatCurrency(vaultTotal) + '</span></div>' +
      '<div class="total-row"><span class="label">Piggy Bank (Goals)</span><span class="value" style="color:var(--accent-blue)">' + formatCurrency(piggyTotal) + '</span></div>' +
      '<div class="total-row total-grand"><span class="label">Grand Total</span><span class="value">' + formatCurrency(grandTotal) + '</span></div>';

    document.getElementById('total-money-modal').classList.remove('hidden');
  }

  // --- Catch Up ---
  function catchUp(bankTotal) {
    const c = state.cycle;
    if (!c.active) return;
    const lockPct = c.lockPercent;
    const locked = roundCents(bankTotal * lockPct / 100);
    const spendable = roundCents(bankTotal - locked);

    c.hiddenSavings = locked;
    c.spendableBalance = spendable;
    c.initialIncome = bankTotal;
    c.categoryBudgets = {
      needs: roundCents(spendable * BUDGET_SPLIT.needs),
      wants: roundCents(spendable * BUDGET_SPLIT.wants),
      savings: roundCents(spendable * BUDGET_SPLIT.savings)
    };
    // Keep existing categorySpent — don't reset spending history
    saveState(); render();
  }

  function showCatchUpPreview(amount) {
    const lockPct = state.cycle.lockPercent;
    const locked = roundCents(amount * lockPct / 100);
    const spendable = roundCents(amount - locked);
    const preview = document.getElementById('catchup-preview');
    preview.classList.remove('hidden');
    preview.innerHTML =
      '<div class="total-row"><span class="label">Locked (' + lockPct + '%)</span><span class="value" style="color:var(--accent-amber)">' + formatCurrency(locked) + '</span></div>' +
      '<div class="total-row"><span class="label">Needs (50%)</span><span class="value" style="color:var(--needs-color)">' + formatCurrency(roundCents(spendable * BUDGET_SPLIT.needs)) + '</span></div>' +
      '<div class="total-row"><span class="label">Wants (30%)</span><span class="value" style="color:var(--wants-color)">' + formatCurrency(roundCents(spendable * BUDGET_SPLIT.wants)) + '</span></div>' +
      '<div class="total-row"><span class="label">Savings (20%)</span><span class="value" style="color:var(--savings-color)">' + formatCurrency(roundCents(spendable * BUDGET_SPLIT.savings)) + '</span></div>';
  }

  // --- Bills ---
  function addBill(name, amount, frequency, priority) {
    state.bills.push({ id: generateId(), name: name.trim(), amount: roundCents(amount), frequency, priority });
    saveState(); render();
  }

  function removeBill(id) {
    state.bills = state.bills.filter(b => b.id !== id);
    if (state.cycle.active) {
      state.cycle.billsPaidThisCycle = state.cycle.billsPaidThisCycle.filter(bid => bid !== id);
    }
    saveState(); render();
  }

  function payBill(billId) {
    const bill = state.bills.find(b => b.id === billId);
    if (!bill || !state.cycle.active) return;
    if (state.cycle.billsPaidThisCycle.includes(billId)) return;
    if (bill.amount > state.cycle.spendableBalance) {
      showWarning('overspend', { attempted: bill.amount, available: state.cycle.spendableBalance });
      return;
    }
    state.cycle.expenses.unshift({
      id: generateId(), amount: bill.amount,
      description: bill.name + ' (Bill)', category: 'needs',
      date: new Date().toISOString(), billId: billId
    });
    state.cycle.spendableBalance = roundCents(state.cycle.spendableBalance - bill.amount);
    state.cycle.categorySpent.needs = roundCents(state.cycle.categorySpent.needs + bill.amount);
    state.cycle.billsPaidThisCycle.push(billId);
    saveState(); render();
  }

  function unpayBill(billId) {
    const c = state.cycle;
    const expIdx = c.expenses.findIndex(e => e.billId === billId);
    if (expIdx === -1) return;
    const exp = c.expenses[expIdx];
    c.spendableBalance = roundCents(c.spendableBalance + exp.amount);
    c.categorySpent.needs = roundCents(c.categorySpent.needs - exp.amount);
    c.expenses.splice(expIdx, 1);
    c.billsPaidThisCycle = c.billsPaidThisCycle.filter(bid => bid !== billId);
    saveState(); render();
  }

  function getBillsDueThisCycle() {
    return state.bills.filter(b => {
      if (b.frequency === 'monthly') return true;
      const cycleCount = state.history.length + 1;
      return cycleCount % 3 === 1;
    });
  }

  function getMonthlyBillsTotal() {
    let total = 0;
    for (const b of state.bills) {
      total += b.frequency === 'quarterly' ? roundCents(b.amount / 3) : b.amount;
    }
    return roundCents(total);
  }

  // --- Goals ---
  function addGoal(name, targetAmount) {
    state.goals.push({ id: generateId(), name: name.trim(), targetAmount: roundCents(targetAmount), savedAmount: 0 });
    saveState(); render();
  }

  function removeGoal(id) {
    state.goals = state.goals.filter(g => g.id !== id);
    state.pendingGoals = state.pendingGoals.filter(g => g.id !== id);
    saveState(); render();
  }

  // --- Smart Deposit ---
  function depositIntoGoal(goalId, amount) {
    const goal = state.goals.find(g => g.id === goalId);
    if (!goal || !state.cycle.active) return false;

    if (amount > state.cycle.spendableBalance) {
      showWarning('overspend', { attempted: amount, available: state.cycle.spendableBalance });
      return false;
    }

    const savingsBudget = state.cycle.categoryBudgets.savings;
    const savingsSpent = state.cycle.categorySpent.savings;
    const savingsRemaining = roundCents(savingsBudget - savingsSpent);
    if (amount <= savingsRemaining) {
      executeDeposit(goal, amount, amount, 0, 'savings');
      return true;
    } else {
      const savingsUsed = Math.max(0, savingsRemaining);
      const overflow = roundCents(amount - savingsUsed);
      pendingFallbackDeposit = { goalId, goal, amount, savingsUsed, overflow };
      showFallbackDepositModal(overflow);
      return false;
    }
  }

  function executeDeposit(goal, totalAmount, savingsAmount, fallbackAmount, fallbackCategory) {
    const c = state.cycle;
    c.spendableBalance = roundCents(c.spendableBalance - totalAmount);

    if (savingsAmount > 0) {
      c.categorySpent.savings = roundCents(c.categorySpent.savings + savingsAmount);
    }
    if (fallbackAmount > 0 && fallbackCategory !== 'savings') {
      c.categorySpent[fallbackCategory] = roundCents(c.categorySpent[fallbackCategory] + fallbackAmount);
    }

    goal.savedAmount = roundCents(goal.savedAmount + totalAmount);

    const desc = fallbackAmount > 0
      ? 'Deposit: ' + goal.name + ' (from savings + ' + fallbackCategory + ')'
      : 'Deposit: ' + goal.name;

    c.expenses.unshift({
      id: generateId(), amount: roundCents(totalAmount),
      description: desc, category: 'savings',
      date: new Date().toISOString()
    });

    saveState(); render();
  }

  function showFallbackDepositModal(overflow) {
    const modal = document.getElementById('fallback-deposit-modal');
    const text = document.getElementById('fallback-deposit-text');
    const c = state.cycle;
    const wantsRemaining = roundCents(c.categoryBudgets.wants - c.categorySpent.wants);
    const needsRemaining = roundCents(c.categoryBudgets.needs - c.categorySpent.needs);

    text.innerHTML = 'Your Savings budget is tapped out. The remaining <strong>' + formatCurrency(overflow) + '</strong> needs to come from somewhere else.<br><br>Wants remaining: <strong>' + formatCurrency(wantsRemaining) + '</strong><br>Needs remaining: <strong>' + formatCurrency(needsRemaining) + '</strong>';

    modal.classList.remove('hidden');
  }

  function completeFallbackDeposit(fallbackCategory) {
    if (!pendingFallbackDeposit) return;
    const { goal, amount, savingsUsed, overflow } = pendingFallbackDeposit;
    const c = state.cycle;
    const catRemaining = roundCents(c.categoryBudgets[fallbackCategory] - c.categorySpent[fallbackCategory]);

    if (overflow > catRemaining) {
      showWarning('category-over', { category: fallbackCategory, attempted: overflow, available: catRemaining });
    }

    executeDeposit(goal, amount, savingsUsed, overflow, fallbackCategory);
    pendingFallbackDeposit = null;
    document.getElementById('fallback-deposit-modal').classList.add('hidden');
  }

  function closeFallbackModal() {
    pendingFallbackDeposit = null;
    document.getElementById('fallback-deposit-modal').classList.add('hidden');
  }

  function allocateSavingsToGoals(totalSaved) {
    const incomplete = state.goals.filter(g => g.savedAmount < g.targetAmount);
    if (!incomplete.length || totalSaved <= 0) return;
    let remaining = totalSaved;
    const perGoal = roundCents(remaining / incomplete.length);
    for (const g of incomplete) {
      const needed = roundCents(g.targetAmount - g.savedAmount);
      const alloc = Math.min(perGoal, needed, remaining);
      g.savedAmount = roundCents(g.savedAmount + alloc);
      remaining = roundCents(remaining - alloc);
    }
    if (remaining > 0) {
      const still = state.goals.filter(g => g.savedAmount < g.targetAmount);
      if (still.length) {
        const needed = roundCents(still[0].targetAmount - still[0].savedAmount);
        still[0].savedAmount = roundCents(still[0].savedAmount + Math.min(remaining, needed));
      }
    }
  }

  // --- Cash In ---
  function handleCashIn(amount) {
    if (amount > state.totalLockedSavings) amount = state.totalLockedSavings;
    state.totalLockedSavings = roundCents(state.totalLockedSavings - amount);
    state._pendingCashIn = roundCents(state._pendingCashIn + amount);
    saveState(); render();
  }

  // --- Calculator ---
  function calculateGoalFeasibility(targetAmount, perCycle) {
    const income = state.biWeeklyIncome || state.cycle.initialIncome || 0;
    const lockPct = state.lockPercent || state.cycle.lockPercent || 20;
    const locked = roundCents(income * lockPct / 100);
    const spendable = roundCents(income - locked);
    const savingsBudget = roundCents(spendable * BUDGET_SPLIT.savings);
    const wantsBudget = roundCents(spendable * BUDGET_SPLIT.wants);
    const needsBudget = roundCents(spendable * BUDGET_SPLIT.needs);
    const monthlyBills = getMonthlyBillsTotal();
    const billsPerCycle = roundCents(monthlyBills / 2);

    const cyclesNeeded = Math.ceil(targetAmount / perCycle);
    const monthsNeeded = Math.round((cyclesNeeded * 2) / 4.33 * 10) / 10;

    const remainingAfter = roundCents(spendable - perCycle);
    let pullsFrom = 'savings';
    let severity = 'green';
    let afterWants = wantsBudget;
    let afterNeeds = needsBudget;
    let afterSavings = savingsBudget;

    if (perCycle <= savingsBudget) {
      afterSavings = roundCents(savingsBudget - perCycle);
      severity = 'green';
      pullsFrom = 'savings';
    } else {
      afterSavings = 0;
      let overflow = roundCents(perCycle - savingsBudget);
      if (overflow <= wantsBudget) {
        afterWants = roundCents(wantsBudget - overflow);
        severity = 'yellow';
        pullsFrom = 'savings + wants';
      } else {
        afterWants = 0;
        overflow = roundCents(overflow - wantsBudget);
        if (overflow <= needsBudget) {
          afterNeeds = roundCents(needsBudget - overflow);
          severity = 'orange';
          pullsFrom = 'savings + wants + needs';
        } else {
          afterNeeds = roundCents(needsBudget - overflow);
          severity = 'red';
          pullsFrom = 'impossible';
        }
      }
    }

    return {
      cyclesNeeded, monthsNeeded, perCycle,
      remainingAfter,
      spendable, locked, income, billsPerCycle, monthlyBills,
      savingsBudget, wantsBudget, needsBudget,
      afterSavings, afterWants, afterNeeds,
      pullsFrom, severity
    };
  }

  // --- Warning System ---
  let warningTimeout = null;
  function showWarning(type, data) {
    const banner = document.getElementById('warning-banner');
    const text = document.getElementById('warning-text');
    if (warningTimeout) clearTimeout(warningTimeout);
    banner.classList.remove('caution');
    switch (type) {
      case 'overspend':
        text.innerHTML = 'STOP. You\'re trying to spend ' + formatCurrency(data.attempted) + ' but you only have <strong>' + formatCurrency(data.available) + '</strong>. You don\'t have this money. Period.';
        break;
      case 'low-balance':
        text.innerHTML = 'WARNING: ' + formatCurrency(data.remaining) + ' left for ' + data.daysLeft + ' day' + (data.daysLeft !== 1 ? 's' : '') + '. That\'s ' + formatCurrency(data.perDay) + '/day. Every dollar counts now.';
        break;
      case 'caution':
        text.innerHTML = 'Think hard. That\'s more than half your remaining budget in one shot. You\'ll have ' + formatCurrency(roundCents(data.remaining - data.amount)) + ' left.';
        banner.classList.add('caution');
        break;
      case 'category-over':
        text.innerHTML = 'You\'re over your <strong>' + data.category + '</strong> budget. ' + formatCurrency(data.available) + ' remaining but spending ' + formatCurrency(data.attempted) + '.';
        banner.classList.add('caution');
        break;
    }
    banner.classList.add('visible');
    if (type !== 'overspend') warningTimeout = setTimeout(dismissWarning, 5000);
  }
  function dismissWarning() {
    document.getElementById('warning-banner').classList.remove('visible');
    if (warningTimeout) { clearTimeout(warningTimeout); warningTimeout = null; }
  }

  // --- SVG Circle ---
  function createCircleSVG(pct, isComplete) {
    const r = 36, circ = 2 * Math.PI * r;
    const offset = circ - (Math.min(pct, 100) / 100) * circ;
    const cls = isComplete ? 'goal-circle-fill complete' : 'goal-circle-fill';
    return '<svg viewBox="0 0 90 90"><circle class="goal-circle-bg" cx="45" cy="45" r="' + r + '"/><circle class="' + cls + '" cx="45" cy="45" r="' + r + '" stroke-dasharray="' + circ + '" stroke-dashoffset="' + offset + '"/></svg><div class="goal-circle-text">' + Math.round(pct) + '%</div>';
  }

  // --- Pie Chart ---
  function drawSavingsPie() {
    const canvas = document.getElementById('savings-pie-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const goals = state.goals.filter(g => g.savedAmount > 0);
    const legend = document.getElementById('savings-pie-legend');
    if (!goals.length) {
      ctx.clearRect(0, 0, 140, 140);
      ctx.fillStyle = '#6E8199';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No savings yet', 70, 75);
      legend.innerHTML = '';
      return;
    }
    const total = goals.reduce((s, g) => s + g.savedAmount, 0);
    ctx.clearRect(0, 0, 140, 140);
    let startAngle = -Math.PI / 2;
    goals.forEach(function(g, i) {
      const slice = (g.savedAmount / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(70, 70);
      ctx.arc(70, 70, 60, startAngle, startAngle + slice);
      ctx.fillStyle = PIE_COLORS[i % PIE_COLORS.length];
      ctx.fill();
      startAngle += slice;
    });
    ctx.beginPath();
    ctx.arc(70, 70, 35, 0, Math.PI * 2);
    ctx.fillStyle = '#2a3830';
    ctx.fill();
    ctx.fillStyle = '#E4CAC5';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(formatCurrency(total), 70, 75);

    legend.innerHTML = goals.map(function(g, i) {
      return '<div class="pie-legend-item"><span class="pie-legend-dot" style="background:' + PIE_COLORS[i % PIE_COLORS.length] + '"></span><span class="pie-legend-label">' + sanitize(g.name) + '</span><span class="pie-legend-value">' + formatCurrency(g.savedAmount) + '</span></div>';
    }).join('');
  }

  // --- Rendering ---
  function render() {
    if (!state.onboardingComplete) return;

    const isActive = state.cycle.active;
    const tabNav = document.getElementById('tab-nav');
    if (isActive || state._lastReport || state.bills.length || state.goals.length) {
      tabNav.classList.remove('hidden');
    } else {
      tabNav.classList.add('hidden');
    }

    renderPreCycle();
    renderIncomeSettings();
    renderCycleStatus();
    renderCategories();
    renderMainArea();
    renderBills();
    renderGoals();
    renderDeposit();
    renderHistory();
    drawSavingsPie();
  }

  function renderPreCycle() {
    const sec = document.getElementById('pre-cycle-section');
    // Show pre-cycle if: onboarding done, no active cycle, no report, payday is in the future
    if (!state.cycle.active && !state._lastReport && state.nextPayday && daysUntil(state.nextPayday) > 0) {
      sec.classList.remove('hidden');
      const days = daysUntil(state.nextPayday);
      const total = roundCents(state.bankBalance + state.extraMoney);
      const daily = days > 0 ? roundCents(total / days) : total;
      document.getElementById('pre-cycle-days').textContent = days;
      document.getElementById('pre-cycle-daily').textContent = formatCurrency(daily) + '/day';
      document.getElementById('pre-cycle-available').textContent = formatCurrency(total);
    } else {
      sec.classList.add('hidden');
    }
  }

  function renderIncomeSettings() {
    const s = document.getElementById('income-settings');
    if (!state.cycle.active) { s.classList.add('hidden'); return; }
    s.classList.remove('hidden');
    document.getElementById('display-income').textContent = formatCurrency(state.cycle.initialIncome);
    document.getElementById('display-locked').textContent = formatCurrency(state.cycle.hiddenSavings) + ' (' + state.cycle.lockPercent + '%)';
    const nextPay = document.getElementById('display-next-payday');
    if (state.nextPayday) {
      nextPay.textContent = formatDateLong(state.nextPayday + 'T00:00:00');
    } else {
      nextPay.textContent = 'Not set';
    }
  }

  function renderCycleStatus() {
    const s = document.getElementById('cycle-status');
    if (!state.cycle.active) { s.classList.add('hidden'); return; }
    s.classList.remove('hidden');
    const c = state.cycle, dl = getDaysRemaining(), de = getDaysElapsed();
    const origSpend = roundCents(c.initialIncome - c.hiddenSavings);
    const cycleDays = getCycleDays();
    document.getElementById('days-count').textContent = dl;
    document.getElementById('spendable-amount').textContent = formatCurrency(c.spendableBalance);

    const vaultTotal = roundCents(state.totalLockedSavings + c.hiddenSavings);
    document.getElementById('hidden-savings').textContent = formatCurrency(vaultTotal) + ' locked away (untouchable)';

    const bal = document.getElementById('spendable-amount');
    bal.classList.remove('low', 'critical');
    if (c.spendableBalance < origSpend * 0.1) bal.classList.add('critical');
    else if (c.spendableBalance < origSpend * 0.2) bal.classList.add('low');
    let seg = '';
    for (let i = 0; i < cycleDays; i++) {
      let cls = 'day-segment';
      if (i < de - 1) cls += ' elapsed';
      else if (i === de - 1 || (de === 0 && i === 0)) cls += ' today';
      seg += '<div class="' + cls + '"></div>';
    }
    document.getElementById('day-progress').innerHTML = seg;
  }

  function renderCategories() {
    const s = document.getElementById('categories-section');
    if (!state.cycle.active) { s.classList.add('hidden'); return; }
    s.classList.remove('hidden');
    const c = state.cycle;
    ['needs', 'wants', 'savings'].forEach(function(cat) {
      const budget = c.categoryBudgets[cat], spent = c.categorySpent[cat];
      const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
      const amtId = cat === 'savings' ? 'savings-cat-amount' : cat + '-amount';
      const spId = cat === 'savings' ? 'savings-cat-spent' : cat + '-spent';
      const barId = cat === 'savings' ? 'savings-bar-fill' : cat + '-bar-fill';
      document.getElementById(amtId).textContent = formatCurrency(Math.max(0, roundCents(budget - spent)));
      document.getElementById(spId).textContent = formatCurrency(spent) + (cat === 'savings' ? ' allocated' : ' spent');
      document.getElementById(barId).style.width = pct + '%';
    });
  }

  function renderMainArea() {
    const startView = document.getElementById('start-cycle-view');
    const activeView = document.getElementById('active-cycle-view');
    const reportView = document.getElementById('report-view');
    startView.classList.add('hidden');
    activeView.classList.add('hidden');
    reportView.classList.add('hidden');

    if (state._lastReport && !state.cycle.active) {
      reportView.classList.remove('hidden');
      renderReport(state._lastReport);
    } else if (state.cycle.active) {
      activeView.classList.remove('hidden');
      renderExpenseLog();
    } else {
      // Show start-cycle only if payday is today or past (or no payday set)
      const daysToPayday = state.nextPayday ? daysUntil(state.nextPayday) : 0;
      if (daysToPayday <= 0) {
        startView.classList.remove('hidden');
        if (state.biWeeklyIncome > 0) {
          document.getElementById('income-input').value = state.biWeeklyIncome;
          document.getElementById('lock-slider').value = state.lockPercent;
          updateLockPreview();
        }
      }
      // If payday is in the future, pre-cycle section handles it
    }
  }

  function renderExpenseLog() {
    const list = document.getElementById('expense-list');
    const noExp = document.getElementById('no-expenses');
    const exps = state.cycle.expenses;
    if (!exps.length) { list.innerHTML = ''; noExp.classList.remove('hidden'); return; }
    noExp.classList.add('hidden');
    list.innerHTML = exps.map(function(e) {
      var catClass = e.billId ? 'bill' : (e.isIncome ? 'income' : e.category);
      var catLabel = e.billId ? 'bill' : (e.isIncome ? 'income' : e.category);
      var amtSign = e.isIncome ? '+' : '-';
      var amtClass = e.isIncome ? 'expense-amount income' : 'expense-amount';
      return '<div class="expense-item"><div class="expense-info"><div class="expense-desc">' + sanitize(e.description) + '</div><div class="expense-meta"><span>' + formatDate(e.date) + '</span><span class="expense-cat-tag ' + catClass + '">' + catLabel + '</span></div></div><span class="' + amtClass + '">' + amtSign + formatCurrency(e.amount) + '</span>' + (e.isIncome ? '' : '<button class="expense-delete" data-action="delete-expense" data-id="' + e.id + '">&times;</button>') + '</div>';
    }).join('');
  }

  function renderReport(r) {
    var card = document.getElementById('report-card');
    var g = r.grade;

    card.innerHTML = '<div class="report-grade"><div class="grade-letter ' + g.class + '">' + sanitize(g.letter) + '</div><div class="grade-message">' + sanitize(g.message) + '</div></div><p class="hint" style="text-align:center;margin-bottom:1rem">' + formatDate(r.startDate) + ' — ' + formatDate(r.endDate) + '</p><div class="report-stats"><div class="report-stat"><div class="report-stat-label">Income</div><div class="report-stat-value blue">' + formatCurrency(r.initialIncome) + '</div></div><div class="report-stat"><div class="report-stat-label">Spent</div><div class="report-stat-value red">' + formatCurrency(r.totalSpent) + '</div></div><div class="report-stat"><div class="report-stat-label">Leftover</div><div class="report-stat-value green">' + formatCurrency(r.leftover) + '</div></div><div class="report-stat"><div class="report-stat-label">This Cycle Locked</div><div class="report-stat-value" style="color:var(--accent-amber)">' + formatCurrency(r.hiddenSavings) + '</div></div></div>';

    var trendHtml = r.trend === 'up'
      ? '<div class="trend-up" style="text-align:center;margin-top:0.75rem;font-weight:700">&#9650; You saved more this cycle!</div>'
      : r.trend === 'down'
      ? '<div class="trend-down" style="text-align:center;margin-top:0.75rem;font-weight:700">&#9660; You saved less this time. Tighten up.</div>'
      : state.history.length > 1
      ? '<div class="trend-same" style="text-align:center;margin-top:0.75rem;font-weight:700">&#9654; Holding steady.</div>'
      : '';
    card.innerHTML += trendHtml;

    // Locked savings vault
    var lockedDisplay = document.getElementById('locked-savings-display');
    var totalLocked = state.totalLockedSavings;

    var growthHtml = '';
    var lockedHistory = state.history.filter(function(h) { return h.totalLockedSavings != null; }).map(function(h) { return h.totalLockedSavings; });
    if (lockedHistory.length > 1) {
      growthHtml = '<div class="locked-growth">' + lockedHistory.map(function(v) { return formatCurrency(v); }).join(' &rarr; ') + '</div>';
    }

    lockedDisplay.innerHTML = '<div class="locked-total">' + formatCurrency(totalLocked) + '</div>' + growthHtml + '<p class="hint" style="text-align:center;margin-bottom:0">This is money you\'ve locked away across all cycles. Keep building it, or cash some in for your next paycheck.</p>';

    document.getElementById('cash-in-form').classList.add('hidden');
    document.getElementById('locked-savings-actions').style.display = totalLocked > 0 ? 'flex' : 'none';
    document.getElementById('cash-in-amount').value = totalLocked > 0 ? totalLocked : '';
    document.getElementById('cash-in-amount').max = totalLocked;

    if (state._pendingCashIn > 0) {
      lockedDisplay.innerHTML += '<div style="text-align:center;margin-top:0.5rem;color:var(--accent-green);font-weight:700">' + formatCurrency(state._pendingCashIn) + ' queued for next paycheck</div>';
    }

    renderProgressStats();
  }

  function renderProgressStats() {
    var section = document.getElementById('progress-section');
    var stats = document.getElementById('progress-stats');
    if (state.history.length < 2) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');

    var maxSaved = Math.max.apply(null, state.history.map(function(h) { return h.totalSaved; }));
    var recent = state.history.slice(-6);

    stats.innerHTML = recent.map(function(h) {
      var pct = maxSaved > 0 ? (h.totalSaved / maxSaved) * 100 : 0;
      return '<div class="progress-bar-row"><span class="cycle-label">' + formatDate(h.startDate) + '</span><div class="progress-bar-track"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div><span class="amount">' + formatCurrency(h.totalSaved) + '</span></div>';
    }).join('');
  }

  function renderBills() {
    var highList = document.getElementById('bills-high-list');
    var lowList = document.getElementById('bills-low-list');
    var highSec = document.getElementById('bills-high-section');
    var lowSec = document.getElementById('bills-low-section');
    var noBills = document.getElementById('no-bills');
    var summary = document.getElementById('bills-summary');

    if (!state.bills.length) {
      highSec.classList.add('hidden'); lowSec.classList.add('hidden');
      summary.classList.add('hidden'); noBills.classList.remove('hidden');
      return;
    }
    noBills.classList.add('hidden');
    summary.classList.remove('hidden');

    var due = getBillsDueThisCycle();
    var cycleDueTotal = due.reduce(function(s, b) { return s + b.amount; }, 0);
    document.getElementById('bills-monthly-total').textContent = formatCurrency(getMonthlyBillsTotal());
    document.getElementById('bills-cycle-total').textContent = formatCurrency(cycleDueTotal);

    var high = state.bills.filter(function(b) { return b.priority === 'high'; });
    var low = state.bills.filter(function(b) { return b.priority === 'low'; });

    function renderBillList(bills, container) {
      container.innerHTML = bills.map(function(b) {
        var isPaid = state.cycle.active && state.cycle.billsPaidThisCycle.includes(b.id);
        var isDue = due.some(function(d) { return d.id === b.id; });
        return '<div class="bill-item"><button class="bill-checkbox ' + (isPaid ? 'checked' : '') + '" data-action="' + (isPaid ? 'unpay-bill' : 'pay-bill') + '" data-id="' + b.id + '" ' + (!state.cycle.active || !isDue ? 'disabled style="opacity:0.3"' : '') + '></button><span class="bill-priority-dot ' + b.priority + '"></span><div class="bill-info"><div class="bill-name ' + (isPaid ? 'paid' : '') + '">' + sanitize(b.name) + '</div><div class="bill-freq">' + (b.frequency === 'quarterly' ? 'Every 3 months' : 'Monthly') + (isDue ? '' : ' (not due this cycle)') + '</div></div><span class="bill-amount ' + (isPaid ? 'paid' : '') + '">' + formatCurrency(b.amount) + '</span><button class="bill-delete" data-action="delete-bill" data-id="' + b.id + '">&times;</button></div>';
      }).join('');
    }

    if (high.length) { highSec.classList.remove('hidden'); renderBillList(high, highList); }
    else highSec.classList.add('hidden');
    if (low.length) { lowSec.classList.remove('hidden'); renderBillList(low, lowList); }
    else lowSec.classList.add('hidden');
  }

  function renderGoals() {
    var list = document.getElementById('goals-list');
    var noGoals = document.getElementById('no-goals');
    var all = state.goals.concat(state.pendingGoals.map(function(g) { return Object.assign({}, g, { pending: true }); }));
    if (!all.length) { list.innerHTML = ''; noGoals.classList.remove('hidden'); return; }
    noGoals.classList.add('hidden');
    list.innerHTML = all.map(function(g) {
      var pct = (g.savedAmount / g.targetAmount) * 100;
      var done = g.savedAmount >= g.targetAmount;
      return '<div class="goal-item"><button class="goal-delete" data-action="delete-goal" data-id="' + g.id + '">&times;</button><div class="goal-circle">' + createCircleSVG(pct, done) + '</div><div class="goal-name">' + sanitize(g.name) + '</div><div class="goal-amounts-text">' + formatCurrency(g.savedAmount) + ' / ' + formatCurrency(g.targetAmount) + '</div>' + (done ? '<div class="goal-complete-label">GOAL REACHED</div>' : '') + (g.pending ? '<div class="goal-pending-label">STARTS NEXT PAYCHECK</div>' : '') + '</div>';
    }).join('');
  }

  function renderDeposit() {
    var sec = document.getElementById('deposit-section');
    var incompleteGoals = state.goals.filter(function(g) { return g.savedAmount < g.targetAmount; });
    if (!state.cycle.active || !incompleteGoals.length) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    var sel = document.getElementById('deposit-goal-select');
    var currentVal = sel.value;
    sel.innerHTML = '<option value="">Choose a goal...</option>' +
      incompleteGoals.map(function(g) { return '<option value="' + g.id + '">' + sanitize(g.name) + ' (' + formatCurrency(roundCents(g.targetAmount - g.savedAmount)) + ' left)</option>'; }).join('');
    sel.value = currentVal;
  }

  function renderHistory() {
    var s = document.getElementById('history-section');
    var l = document.getElementById('history-list');
    if (!state.history.length) { s.classList.add('hidden'); return; }
    s.classList.remove('hidden');
    l.innerHTML = state.history.slice().reverse().map(function(h) {
      return '<div class="history-item"><div><div class="history-dates">' + formatDate(h.startDate) + ' — ' + formatDate(h.endDate) + '</div><div class="history-saved">Saved ' + formatCurrency(h.totalSaved) + '</div></div><span class="history-grade">' + sanitize(h.grade) + '</span></div>';
    }).join('');
  }

  // --- Calculator Modal ---
  function openCalcModal() {
    document.getElementById('calc-modal').classList.remove('hidden');
    document.getElementById('calc-comparison').classList.add('hidden');
    document.getElementById('calc-apply-btn').classList.add('hidden');
  }

  function closeCalcModal() {
    document.getElementById('calc-modal').classList.add('hidden');
  }

  function renderCalcResult(name, target, r) {
    var comp = document.getElementById('calc-comparison');
    comp.classList.remove('hidden');
    document.getElementById('calc-result-title').textContent = name + ' — ' + formatCurrency(target);

    var valClass = { green: 'val-green', yellow: 'val-yellow', orange: 'val-orange', red: 'val-red' }[r.severity] || 'val-neutral';

    document.getElementById('calc-before').innerHTML =
      '<div class="calc-row"><span class="label">Needs</span><span class="value val-neutral">' + formatCurrency(r.needsBudget) + '</span></div>' +
      '<div class="calc-row"><span class="label">Wants</span><span class="value val-neutral">' + formatCurrency(r.wantsBudget) + '</span></div>' +
      '<div class="calc-row"><span class="label">Savings</span><span class="value val-neutral">' + formatCurrency(r.savingsBudget) + '</span></div>' +
      (r.billsPerCycle > 0 ? '<div class="calc-row"><span class="label">Bills</span><span class="value val-neutral">' + formatCurrency(r.billsPerCycle) + '</span></div>' : '') +
      '<div class="calc-row" style="border-top:1px solid var(--border);margin-top:0.25rem;padding-top:0.25rem"><span class="label">Free</span><span class="value">' + formatCurrency(r.spendable) + '</span></div>';

    document.getElementById('calc-after').innerHTML =
      '<div class="calc-row"><span class="label">Needs</span><span class="value ' + (r.afterNeeds < r.needsBudget ? valClass : 'val-neutral') + '">' + formatCurrency(Math.max(0, r.afterNeeds)) + '</span></div>' +
      '<div class="calc-row"><span class="label">Wants</span><span class="value ' + (r.afterWants < r.wantsBudget ? valClass : 'val-neutral') + '">' + formatCurrency(Math.max(0, r.afterWants)) + '</span></div>' +
      '<div class="calc-row"><span class="label">Savings</span><span class="value ' + (r.afterSavings < r.savingsBudget ? valClass : 'val-neutral') + '">' + formatCurrency(Math.max(0, r.afterSavings)) + '</span></div>' +
      (r.billsPerCycle > 0 ? '<div class="calc-row"><span class="label">Bills</span><span class="value val-neutral">' + formatCurrency(r.billsPerCycle) + '</span></div>' : '') +
      '<div class="calc-row" style="border-top:1px solid var(--border);margin-top:0.25rem;padding-top:0.25rem"><span class="label">Free</span><span class="value ' + valClass + '">' + formatCurrency(Math.max(0, r.remainingAfter)) + '</span></div>';

    document.getElementById('calc-stats').innerHTML =
      '<div class="calc-stat"><span class="label">Per Paycheck</span><span class="value">' + formatCurrency(r.perCycle) + '</span></div>' +
      '<div class="calc-stat"><span class="label">Paychecks Needed</span><span class="value">' + r.cyclesNeeded + '</span></div>' +
      '<div class="calc-stat"><span class="label">Time to Goal</span><span class="value">' + r.monthsNeeded + ' months</span></div>' +
      '<div class="calc-stat"><span class="label">Pulls From</span><span class="value ' + valClass + '">' + r.pullsFrom + '</span></div>';

    var verdict = document.getElementById('calc-verdict');
    var verdictMessages = {
      green: 'This fits within your savings budget. No cuts needed — ' + formatCurrency(r.afterSavings) + ' still left in savings.',
      yellow: 'This pulls from your Wants budget. Wants drops to ' + formatCurrency(Math.max(0, r.afterWants)) + '. The app will automatically reduce Wants first.',
      orange: 'DRASTIC CUT. This eats into your Needs budget too. Wants goes to $0, Needs drops to ' + formatCurrency(Math.max(0, r.afterNeeds)) + '.' + (r.billsPerCycle > 0 ? ' Make sure you can still cover your bills (' + formatCurrency(r.billsPerCycle) + '/cycle).' : ''),
      red: 'NOT POSSIBLE. ' + formatCurrency(r.perCycle) + '/paycheck exceeds your entire spendable income. You\'d be ' + formatCurrency(Math.abs(r.remainingAfter)) + ' in the negative. Lower the amount per paycheck.'
    };
    verdict.className = 'calc-verdict verdict-' + r.severity;
    verdict.textContent = verdictMessages[r.severity];

    var applyBtn = document.getElementById('calc-apply-btn');
    if (r.severity !== 'red') {
      applyBtn.classList.remove('hidden');
      applyBtn.textContent = state.cycle.active ? 'Apply as Goal (starts next paycheck)' : 'Add as Goal';
      applyBtn.disabled = false;
      applyBtn.onclick = function () {
        var goal = { id: generateId(), name: name.trim(), targetAmount: roundCents(target), savedAmount: 0 };
        if (state.cycle.active) {
          state.pendingGoals.push(goal);
          applyBtn.textContent = 'Queued for next paycheck';
        } else {
          state.goals.push(goal);
          applyBtn.textContent = 'Goal added';
        }
        applyBtn.disabled = true;
        saveState(); render();
      };
    } else {
      applyBtn.classList.add('hidden');
    }
  }

  // --- Lock Preview ---
  function updateLockPreview() {
    var income = parseFloat(document.getElementById('income-input').value) || 0;
    var lockPct = parseInt(document.getElementById('lock-slider').value) || 20;
    document.getElementById('lock-display').textContent = lockPct + '%';
    document.getElementById('preview-locked').textContent = formatCurrency(roundCents(income * lockPct / 100));
    document.getElementById('preview-spendable').textContent = formatCurrency(roundCents(income - income * lockPct / 100));
  }

  // --- Reset ---
  function resetApp() {
    if (!confirm('Are you sure you want to reset everything? All data will be lost.')) return;
    localStorage.removeItem(STORAGE_KEY);
    state = getDefaultState();
    showOnboarding();
    showOnboardStep('onboard-welcome');
  }

  // --- Events ---
  function setupEventListeners() {
    // === ONBOARDING EVENTS ===
    document.getElementById('onboard-start-btn').addEventListener('click', function () {
      showOnboardStep('onboard-path');
    });

    // Path choice
    document.getElementById('onboard-just-paid').addEventListener('click', function () {
      onboardPath = 'just-paid';
      state.bankBalance = 0;
      // Show paycheck step with payday hidden
      document.getElementById('onboard-payday-group').classList.add('hidden');
      document.getElementById('onboard-step3-title').textContent = 'How much is your paycheck?';
      document.getElementById('onboard-step3-hint').textContent = 'Enter your paycheck amount. The app will lock away a portion and budget the rest.';
      showOnboardStep('onboard-step3');
    });

    document.getElementById('onboard-waiting').addEventListener('click', function () {
      onboardPath = 'waiting';
      // Show bank balance step (normal flow)
      document.getElementById('onboard-payday-group').classList.remove('hidden');
      document.getElementById('onboard-step3-title').textContent = 'When do you get paid?';
      document.getElementById('onboard-step3-hint').textContent = 'Set your next payday. The app will remember your pay schedule from here.';
      showOnboardStep('onboard-step1');
    });

    document.getElementById('onboard-next1').addEventListener('click', function () {
      var val = parseFloat(document.getElementById('onboard-bank').value);
      if (isNaN(val) || val < 0) val = 0;
      state.bankBalance = roundCents(val);
      showOnboardStep('onboard-step2');
    });

    document.getElementById('onboard-next2').addEventListener('click', function () {
      var val = parseFloat(document.getElementById('onboard-extra').value);
      if (isNaN(val) || val < 0) val = 0;
      state.extraMoney = roundCents(val);
      if (onboardPath === 'just-paid') {
        // Just paid: skip to lock recommendation
        var income = state.biWeeklyIncome;
        var rec = computeRecommendedLock(0, state.extraMoney, 0, income);
        document.getElementById('onboard-lock-slider').value = rec;
        document.getElementById('onboard-lock-display').textContent = rec + '%';
        state.lockPercent = rec;
        showOnboardStep('onboard-step4');
        renderOnboardRecommendation();
      } else {
        // Waiting: go to payday step
        showOnboardStep('onboard-step3');
        document.getElementById('onboard-payday').min = today();
      }
    });

    document.getElementById('onboard-next3').addEventListener('click', function () {
      var income = parseFloat(document.getElementById('onboard-income').value);
      var freq = parseInt(document.getElementById('onboard-frequency').value);
      if (isNaN(income) || income <= 0) {
        alert('Please fill in your paycheck amount.');
        return;
      }
      state.biWeeklyIncome = roundCents(income);
      state.payCycleDays = freq;

      if (onboardPath === 'just-paid') {
        // Just paid: skip payday, go to extra money
        state.nextPayday = today();
        showOnboardStep('onboard-step2');
      } else {
        // Waiting: validate payday
        var payday = document.getElementById('onboard-payday').value;
        if (!payday) {
          alert('Please select your next payday.');
          return;
        }
        state.nextPayday = payday;
        var rec = computeRecommendedLock(state.bankBalance, state.extraMoney, daysUntil(payday), income);
        document.getElementById('onboard-lock-slider').value = rec;
        document.getElementById('onboard-lock-display').textContent = rec + '%';
        state.lockPercent = rec;
        showOnboardStep('onboard-step4');
        renderOnboardRecommendation();
      }
    });

    document.getElementById('onboard-lock-slider').addEventListener('input', function () {
      document.getElementById('onboard-lock-display').textContent = this.value + '%';
      state.lockPercent = parseInt(this.value);
      renderOnboardRecommendation();
    });

    document.getElementById('onboard-finish-btn').addEventListener('click', function () {
      completeOnboarding();
    });

    // === MAIN APP EVENTS ===

    // Tabs
    document.getElementById('tab-nav').addEventListener('click', function (e) {
      var btn = e.target.closest('.tab-btn');
      if (btn) switchTab(btn.dataset.tab);
    });

    // Savings category click -> go to savings tab
    document.getElementById('savings-cat-card').addEventListener('click', function (e) {
      if (e.target.closest('.savings-pie-tooltip')) return;
      switchTab('savings');
    });

    // Income form
    document.getElementById('income-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var income = parseFloat(document.getElementById('income-input').value);
      var lockPct = parseInt(document.getElementById('lock-slider').value);
      if (isNaN(income) || income <= 0) return;
      startCycle(roundCents(income), lockPct);
      document.getElementById('income-input').value = '';
    });
    document.getElementById('lock-slider').addEventListener('input', updateLockPreview);
    document.getElementById('income-input').addEventListener('input', updateLockPreview);

    // Edit income
    document.getElementById('edit-income-btn').addEventListener('click', function () {
      var form = document.getElementById('edit-income-form');
      var display = document.getElementById('income-display');
      form.classList.toggle('hidden'); display.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) {
        document.getElementById('edit-income-input').value = state.cycle.initialIncome;
        document.getElementById('edit-lock-slider').value = state.cycle.lockPercent;
        document.getElementById('edit-lock-display').textContent = state.cycle.lockPercent + '%';
        if (state.nextPayday) document.getElementById('edit-payday-input').value = state.nextPayday;
        document.getElementById('edit-frequency').value = state.payCycleDays;
      }
    });
    document.getElementById('cancel-edit-income').addEventListener('click', function () {
      document.getElementById('edit-income-form').classList.add('hidden');
      document.getElementById('income-display').classList.remove('hidden');
    });
    document.getElementById('edit-lock-slider').addEventListener('input', function () {
      document.getElementById('edit-lock-display').textContent = this.value + '%';
    });
    document.getElementById('edit-income-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var val = parseFloat(document.getElementById('edit-income-input').value);
      var pct = parseInt(document.getElementById('edit-lock-slider').value);
      var newPayday = document.getElementById('edit-payday-input').value || null;
      var newFreq = document.getElementById('edit-frequency').value;
      if (isNaN(val) || val <= 0) return;
      updateIncome(roundCents(val), pct, newPayday, newFreq);
      this.classList.add('hidden');
      document.getElementById('income-display').classList.remove('hidden');
    });

    // Pre-cycle "I Got Paid Early"
    document.getElementById('pre-cycle-paid-btn').addEventListener('click', function () {
      // Jump to start cycle view
      state.nextPayday = today();
      saveState();
      render();
    });

    // Expense form
    document.getElementById('expense-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var amt = parseFloat(document.getElementById('expense-amount').value);
      var desc = document.getElementById('expense-desc').value.trim();
      var cat = document.querySelector('input[name="expense-cat"]:checked').value;
      if (isNaN(amt) || amt <= 0 || !desc) return;
      if (addExpense(roundCents(amt), desc, cat)) {
        document.getElementById('expense-amount').value = '';
        document.getElementById('expense-desc').value = '';
      }
    });

    // Bonus money modal
    document.getElementById('add-bonus-btn').addEventListener('click', function () {
      document.getElementById('bonus-modal').classList.remove('hidden');
    });
    document.getElementById('close-bonus-modal').addEventListener('click', function () {
      document.getElementById('bonus-modal').classList.add('hidden');
    });
    document.getElementById('bonus-modal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });
    document.getElementById('bonus-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var amt = parseFloat(document.getElementById('bonus-amount').value);
      var dest = document.querySelector('input[name="bonus-dest"]:checked');
      if (isNaN(amt) || amt <= 0 || !dest) return;
      addBonusMoney(roundCents(amt), dest.value);
      document.getElementById('bonus-amount').value = '';
      document.getElementById('bonus-modal').classList.add('hidden');
    });

    // Fallback deposit modal
    document.getElementById('fallback-wants-btn').addEventListener('click', function () {
      completeFallbackDeposit('wants');
    });
    document.getElementById('fallback-needs-btn').addEventListener('click', function () {
      completeFallbackDeposit('needs');
    });
    document.getElementById('fallback-cancel-btn').addEventListener('click', closeFallbackModal);
    document.getElementById('close-fallback-modal').addEventListener('click', closeFallbackModal);
    document.getElementById('fallback-deposit-modal').addEventListener('click', function (e) {
      if (e.target === this) closeFallbackModal();
    });

    // Bills
    document.getElementById('add-bill-btn').addEventListener('click', function () {
      document.getElementById('bill-form').classList.toggle('hidden');
    });
    document.getElementById('cancel-bill').addEventListener('click', function () {
      document.getElementById('bill-form').classList.add('hidden');
    });
    document.getElementById('bill-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = document.getElementById('bill-name').value.trim();
      var amt = parseFloat(document.getElementById('bill-amount').value);
      var freq = document.getElementById('bill-frequency').value;
      var pri = document.getElementById('bill-priority').value;
      if (!name || isNaN(amt) || amt <= 0) return;
      addBill(name, amt, freq, pri);
      document.getElementById('bill-name').value = '';
      document.getElementById('bill-amount').value = '';
      document.getElementById('bill-form').classList.add('hidden');
    });

    // Goals
    document.getElementById('toggle-goal-form').addEventListener('click', function () {
      document.getElementById('goal-form').classList.toggle('hidden');
    });
    document.getElementById('cancel-goal').addEventListener('click', function () {
      document.getElementById('goal-form').classList.add('hidden');
    });
    document.getElementById('goal-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = document.getElementById('goal-name').value.trim();
      var amt = parseFloat(document.getElementById('goal-amount').value);
      if (!name || isNaN(amt) || amt <= 0) return;
      addGoal(name, roundCents(amt));
      document.getElementById('goal-name').value = '';
      document.getElementById('goal-amount').value = '';
      document.getElementById('goal-form').classList.add('hidden');
    });

    // Deposit
    document.getElementById('deposit-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var goalId = document.getElementById('deposit-goal-select').value;
      var amt = parseFloat(document.getElementById('deposit-amount').value);
      if (!goalId || isNaN(amt) || amt <= 0) return;
      if (depositIntoGoal(goalId, roundCents(amt))) {
        document.getElementById('deposit-amount').value = '';
        document.getElementById('deposit-goal-select').value = '';
      }
    });

    // New cycle (auto payday)
    document.getElementById('new-cycle-btn').addEventListener('click', function () {
      state._lastReport = null;
      if (state.biWeeklyIncome > 0) {
        startCycle(state.biWeeklyIncome, state.lockPercent);
      } else {
        saveState(); render();
      }
    });

    // Keep locked
    document.getElementById('keep-locked-btn').addEventListener('click', function () {
      state._lastReport = null;
      if (state.biWeeklyIncome > 0) {
        startCycle(state.biWeeklyIncome, state.lockPercent);
      } else {
        saveState(); render();
      }
    });

    // Cash in
    document.getElementById('cash-in-btn').addEventListener('click', function () {
      document.getElementById('cash-in-form').classList.remove('hidden');
      this.classList.add('hidden');
      document.getElementById('keep-locked-btn').classList.add('hidden');
    });
    document.getElementById('cancel-cash-in').addEventListener('click', function () {
      document.getElementById('cash-in-form').classList.add('hidden');
      document.getElementById('cash-in-btn').classList.remove('hidden');
      document.getElementById('keep-locked-btn').classList.remove('hidden');
    });
    document.getElementById('confirm-cash-in').addEventListener('click', function () {
      var amt = parseFloat(document.getElementById('cash-in-amount').value);
      if (isNaN(amt) || amt <= 0) return;
      handleCashIn(roundCents(amt));
      document.getElementById('cash-in-form').classList.add('hidden');
      document.getElementById('cash-in-btn').classList.remove('hidden');
      document.getElementById('keep-locked-btn').classList.remove('hidden');
    });

    // Calculator modal
    document.getElementById('open-calculator').addEventListener('click', openCalcModal);
    document.getElementById('close-calc-modal').addEventListener('click', closeCalcModal);
    document.getElementById('calc-modal').addEventListener('click', function (e) {
      if (e.target === this) closeCalcModal();
    });
    document.getElementById('calc-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = document.getElementById('calc-item-name').value.trim();
      var target = parseFloat(document.getElementById('calc-target').value);
      var perCycle = parseFloat(document.getElementById('calc-per-cycle').value);
      if (!name || isNaN(target) || target <= 0 || isNaN(perCycle) || perCycle <= 0) return;
      var result = calculateGoalFeasibility(target, perCycle);
      renderCalcResult(name, target, result);
    });

    // Dismiss warning
    document.getElementById('dismiss-warning').addEventListener('click', dismissWarning);

    // View Total Money
    document.getElementById('view-total-btn').addEventListener('click', showTotalMoneyModal);
    document.getElementById('close-total-modal').addEventListener('click', function () {
      document.getElementById('total-money-modal').classList.add('hidden');
    });
    document.getElementById('total-money-modal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });

    // Catch Up
    document.getElementById('catchup-btn').addEventListener('click', function () {
      document.getElementById('catchup-amount').value = '';
      document.getElementById('catchup-preview').classList.add('hidden');
      document.getElementById('catchup-modal').classList.remove('hidden');
    });
    document.getElementById('close-catchup-modal').addEventListener('click', function () {
      document.getElementById('catchup-modal').classList.add('hidden');
    });
    document.getElementById('cancel-catchup').addEventListener('click', function () {
      document.getElementById('catchup-modal').classList.add('hidden');
    });
    document.getElementById('catchup-modal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });
    document.getElementById('catchup-amount').addEventListener('input', function () {
      var val = parseFloat(this.value);
      if (!isNaN(val) && val > 0) showCatchUpPreview(roundCents(val));
      else document.getElementById('catchup-preview').classList.add('hidden');
    });
    document.getElementById('catchup-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var amt = parseFloat(document.getElementById('catchup-amount').value);
      if (isNaN(amt) || amt <= 0) return;
      catchUp(roundCents(amt));
      document.getElementById('catchup-modal').classList.add('hidden');
    });

    // Reset app
    document.getElementById('reset-app-btn').addEventListener('click', resetApp);

    // Event delegation
    document.getElementById('app').addEventListener('click', function (e) {
      var t = e.target.closest('[data-action]');
      if (!t) return;
      var action = t.dataset.action, id = t.dataset.id;
      if (action === 'delete-expense') removeExpense(id);
      else if (action === 'delete-goal') { if (confirm('Remove this goal? Saved progress will be lost.')) removeGoal(id); }
      else if (action === 'delete-bill') { if (confirm('Remove this bill?')) removeBill(id); }
      else if (action === 'pay-bill') payBill(id);
      else if (action === 'unpay-bill') unpayBill(id);
    });

    // Multi-tab sync
    window.addEventListener('storage', function (e) {
      if (e.key === STORAGE_KEY) { state = loadState(); render(); }
    });
  }

  // --- Init ---
  setupEventListeners();

  if (!state.onboardingComplete) {
    showOnboarding();
  } else {
    hideOnboarding();
    checkCycleExpiry();
    render();
    startClock();
  }

  setInterval(checkCycleExpiry, 60000);
})();
