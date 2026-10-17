/* LoanDesk frontend backed by the local JSON API. */
(() => {
  'use strict';

  const STATUSES = ['Submitted', 'Under Review', 'Approved', 'Disbursed', 'Repaying', 'Closed', 'Rejected'];
  const STATUS_CLASS = {
    'Submitted': 'status-submitted',
    'Under Review': 'status-under-review',
    'Approved': 'status-approved',
    'Disbursed': 'status-disbursed',
    'Repaying': 'status-repaying',
    'Closed': 'status-closed',
    'Rejected': 'status-rejected'
  };
  const PROCESS_STEPS = ['Application', 'Review', 'Decision', 'Disbursement', 'Repayment'];

  let loans = [];
  let currentUser = null;
  let loginRole = 'borrower';
  let activeLoanId = null;
  let toastTimer = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function money(value, compact = false) {
    const numeric = Number(value) || 0;
    if (compact && numeric >= 10000000) return `₹${(numeric / 10000000).toFixed(1)}Cr`;
    if (compact && numeric >= 100000) return `₹${(numeric / 100000).toFixed(1)}L`;
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(numeric);
  }

  function formatDate(dateValue) {
    if (!dateValue) return '—';
    const date = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }

  function formatNameInitials(name) {
    return String(name || 'NA').trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join('').toUpperCase();
  }

  function slugStatus(status) {
    return String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function statusBadge(status) {
    const className = STATUS_CLASS[status] || 'status-closed';
    return `<span class="status-badge ${className}">${escapeHtml(status)}</span>`;
  }

  function calculateEmi(loan) {
    const principal = Math.max(0, Number(loan.amount) || 0);
    const months = Math.max(1, Number(loan.tenureMonths) || 1);
    const monthlyRate = Math.max(0, Number(loan.annualRate) || 0) / 1200;
    if (!monthlyRate) return principal / months;
    const factor = Math.pow(1 + monthlyRate, months);
    return principal * monthlyRate * factor / (factor - 1);
  }

  function calculateOutstanding(loan) {
    const principal = Math.max(0, Number(loan.amount) || 0);
    const months = Math.max(1, Number(loan.tenureMonths) || 1);
    const paid = Math.max(0, Math.min(Number(loan.paidInstallments) || 0, months));
    const rate = Math.max(0, Number(loan.annualRate) || 0) / 1200;
    const emi = calculateEmi(loan);
    if (!rate) return Math.max(0, principal - emi * paid);
    const balance = principal * Math.pow(1 + rate, paid) - emi * ((Math.pow(1 + rate, paid) - 1) / rate);
    return Math.max(0, balance);
  }

  function countNeedsReview(loan) {
    return loan.status === 'Submitted' || loan.status === 'Under Review';
  }

  function isActiveLoan(loan) {
    return loan.status === 'Disbursed' || loan.status === 'Repaying';
  }

  function showLogin(message = '') {
    $('#loginScreen').hidden = false;
    $('.app-shell').hidden = true;
    $('#loginError').textContent = message;
    $('#loginError').hidden = !message;
  }

  async function loadLoans() {
    const response = await fetch('/api/loans', { headers: { 'Accept': 'application/json' } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load loan applications.');
    loans = normalizeLoans(result.loans);
    renderAll();
  }

  function showApplication() {
    $('#loginScreen').hidden = true;
    $('.app-shell').hidden = false;
    const isManager = currentUser.role === 'manager';
    document.body.classList.toggle('borrower-mode', !isManager);
    $$('.manager-only').forEach((element) => { element.hidden = !isManager; });
    $$('.borrower-only').forEach((element) => { element.hidden = isManager; });
    $('#storageModeLabel').textContent = 'JSON file storage';
    $('#storageModeLabel').title = 'Saved to data.json by the local Node server';
    $('#sidebarUserName').textContent = currentUser.name;
    $('#sidebarUserRole').textContent = isManager ? 'Bank manager' : 'Borrower';
    $('#sidebarAvatar').textContent = formatNameInitials(currentUser.name);
    $('#topAvatar').textContent = formatNameInitials(currentUser.name).charAt(0);
    $('#pageEyebrow').textContent = isManager ? 'PORTFOLIO OVERVIEW' : 'BORROWER PORTAL';
    $('#pageTitle').textContent = isManager ? 'Loan management' : 'Your loan requests';
    $('#pageSubtitle').textContent = isManager
      ? 'Review applications, make lending decisions, and manage repayments.'
      : 'Request a loan and follow its progress through the review process.';
    $('#applicationsTitle').textContent = isManager ? 'Loan applications' : 'Your applications';
    $('#applicationsSubtitle').textContent = isManager
      ? 'Review applicant details and update each application stage.'
      : 'Check the status and details of each request you have submitted.';
    $$('.stat-label')[0].textContent = isManager ? 'Total applications' : 'Your requests';
    $$('.stat-label')[1].textContent = isManager ? 'Needs review' : 'Requests in review';
    $$('.stat-foot')[0].lastChild.textContent = isManager ? ' All submitted applications' : ' Your submitted applications';
    $('#openApplicationButton').innerHTML = '<span class="button-plus" aria-hidden="true">+</span> Request a loan';
    $('#applicationApplicant').textContent = currentUser.name;
    renderAll();
  }

  async function initialize() {
    try {
      const response = await fetch('/api/session', { headers: { 'Accept': 'application/json' } });
      if (!response.ok) {
        showLogin();
        return;
      }
      const result = await response.json();
      currentUser = result.user;
      await loadLoans();
      showApplication();
    } catch (_error) {
      showLogin('Start the local Node server, then refresh this page.');
    }
  }

  function normalizeLoans(items) {
    return items.filter((item) => item && typeof item === 'object' && item.id).map((item) => ({
      ...item,
      applicant: String(item.applicant || 'Unnamed applicant'),
      amount: Math.max(0, Number(item.amount) || 0),
      tenureMonths: Math.max(1, Number(item.tenureMonths) || 1),
      annualRate: Math.max(0, Number(item.annualRate) || 0),
      paidInstallments: Math.max(0, Number(item.paidInstallments) || 0),
      status: STATUSES.includes(item.status) ? item.status : 'Submitted'
    }));
  }

  function renderAll() {
    renderStats();
    renderTable();
    $('#navApplicationCount').textContent = String(loans.length);
  }

  function renderStats() {
    const reviewCount = loans.filter(countNeedsReview).length;
    const active = loans.filter(isActiveLoan);
    const outstanding = active.reduce((sum, loan) => sum + calculateOutstanding(loan), 0);
    $('#totalApplications').textContent = String(loans.length);
    $('#needsReview').textContent = String(reviewCount);
    $('#activeLoans').textContent = String(active.length);
    $('#outstandingBalance').textContent = money(outstanding, true);
    $('#outstandingBalance').title = money(outstanding);
  }

  function renderTable() {
    const query = $('#searchInput').value.trim().toLowerCase();
    const status = $('#statusFilter').value;
    const filtered = loans.filter((loan) => {
      const haystack = `${loan.applicant} ${loan.id} ${loan.phone} ${loan.purpose}`.toLowerCase();
      return haystack.includes(query) && (status === 'All' || loan.status === status);
    }).sort((a, b) => new Date(b.appliedDate || b.createdAt) - new Date(a.appliedDate || a.createdAt));

    const body = $('#applicationsTableBody');
    body.innerHTML = filtered.map((loan, index) => {
      const emi = calculateEmi(loan);
      const avatarClass = `avatar-${index % 5}`;
      return `<tr>
        <td><div class="applicant-cell"><div class="applicant-avatar ${avatarClass}">${escapeHtml(formatNameInitials(loan.applicant))}</div><div><span class="applicant-name">${escapeHtml(loan.applicant)}</span><span class="applicant-id">${escapeHtml(loan.id)}</span></div></div></td>
        <td><span class="amount-main">${money(loan.amount)}</span><span class="amount-sub">EMI ${money(emi)}/mo</span></td>
        <td>${escapeHtml(loan.tenureMonths)} months</td>
        <td>${formatDate(loan.appliedDate)}</td>
        <td>${statusBadge(loan.status)}</td>
        <td><button class="row-action" type="button" data-view-loan="${escapeHtml(loan.id)}">View details <span aria-hidden="true">↗</span></button></td>
      </tr>`;
    }).join('');

    $('#emptyState').hidden = filtered.length > 0;
    $('.loan-table').hidden = filtered.length === 0;
    $('#tableCount').textContent = `Showing ${filtered.length} of ${loans.length} application${loans.length === 1 ? '' : 's'}`;
  }

  function showToast(message, isError = false) {
    const region = $('#toastRegion');
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3300);
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const focusTarget = modal.querySelector('input, select, button');
    if (focusTarget) window.setTimeout(() => focusTarget.focus(), 50);
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.hidden = true;
    if ($$('.modal-backdrop').every((element) => element.hidden)) document.body.style.overflow = '';
    activeLoanId = null;
  }

  async function createApplication(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const amount = Number(formData.get('amount'));
    const tenureMonths = Number(formData.get('tenureMonths'));
    const error = $('#applicationFormError');
    error.hidden = true;

    if (!Number.isFinite(amount) || amount < 1000 || amount > 100000000 || !Number.isInteger(tenureMonths) || tenureMonths < 1 || tenureMonths > 360) {
      error.textContent = 'Please check the amount and repayment term, then try again.';
      error.hidden = false;
      return;
    }

    try {
      const response = await fetch('/api/loans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ amount, purpose: formData.get('purpose'), tenureMonths })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not submit this request.');
      form.reset();
      form.elements.tenureMonths.value = '12';
      closeModal('applicationModal');
      await loadLoans();
      showToast(`Request ${result.loan.id} submitted for review.`);
      showDetails(result.loan.id);
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
    }
  }

  function getStepIndex(status) {
    switch (status) {
      case 'Submitted': return 0;
      case 'Under Review': return 1;
      case 'Approved': return 2;
      case 'Disbursed': return 3;
      case 'Repaying': return 4;
      case 'Closed': return 4;
      case 'Rejected': return 2;
      default: return 0;
    }
  }

  function renderMiniProgress(loan) {
    const currentIndex = getStepIndex(loan.status);
    return `<div class="mini-progress">${PROCESS_STEPS.map((step, index) => {
      const done = loan.status === 'Closed' || index < currentIndex;
      const current = index === currentIndex && loan.status !== 'Closed';
      const cls = done ? 'done' : current ? 'current' : '';
      const marker = done ? '✓' : String(index + 1);
      return `<div class="mini-step ${cls}"><span class="mini-step-circle">${marker}</span><small>${step}</small></div>`;
    }).join('')}</div>`;
  }

  function getPrimaryAction(loan) {
    if (loan.status === 'Submitted') return { label: 'Start review', action: 'next' };
    if (loan.status === 'Under Review') return { label: 'Approve application', action: 'next' };
    if (loan.status === 'Approved') return { label: 'Disburse loan', action: 'next' };
    if (loan.status === 'Disbursed') return { label: 'Start repayment tracking', action: 'next' };
    if (loan.status === 'Repaying') {
      if (Number(loan.paidInstallments) >= Number(loan.tenureMonths)) return { label: 'Close loan', action: 'close' };
      return { label: 'Record next EMI', action: 'payment' };
    }
    if (loan.status === 'Closed') return { label: 'Loan fully repaid', action: 'closed' };
    return { label: 'Application rejected', action: 'rejected' };
  }

  function showDetails(id) {
    const loan = loans.find((item) => item.id === id);
    if (!loan) return;
    activeLoanId = id;
    const emi = calculateEmi(loan);
    const outstanding = isActiveLoan(loan) ? calculateOutstanding(loan) : (loan.status === 'Closed' ? 0 : null);
    const action = getPrimaryAction(loan);
    const isManager = currentUser.role === 'manager';
    const canReject = isManager && ['Submitted', 'Under Review', 'Approved'].includes(loan.status);
    const paid = Math.min(Number(loan.paidInstallments) || 0, Number(loan.tenureMonths) || 1);
    const progress = Math.round((paid / Math.max(1, Number(loan.tenureMonths) || 1)) * 100);
    const principalLabel = outstanding === null ? 'Not disbursed' : money(outstanding);
    $('#detailsLoanId').textContent = loan.id;
    $('#detailsTitle').textContent = loan.applicant;
    $('#detailsSubtitle').textContent = `${loan.purpose} loan · Applied ${formatDate(loan.appliedDate)}`;
    $('#detailsContent').innerHTML = `
      <div class="detail-summary-grid">
        <div class="detail-metric"><span>Loan amount</span><strong>${money(loan.amount)}</strong></div>
        <div class="detail-metric"><span>Estimated monthly EMI</span><strong>${money(emi)}</strong></div>
        <div class="detail-metric"><span>Application status</span><strong>${statusBadge(loan.status)}</strong></div>
      </div>
      <div class="detail-meta">
        <div class="meta-item"><span>Loan ID</span><strong>${escapeHtml(loan.id)}</strong></div>
        <div class="meta-item"><span>Applicant phone</span><strong>${escapeHtml(loan.phone || '—')}</strong></div>
        <div class="meta-item"><span>Email address</span><strong>${escapeHtml(loan.email || '—')}</strong></div>
        <div class="meta-item"><span>Purpose</span><strong>${escapeHtml(loan.purpose || '—')}</strong></div>
        <div class="meta-item"><span>Tenure</span><strong>${escapeHtml(loan.tenureMonths)} months</strong></div>
        <div class="meta-item"><span>Annual interest rate</span><strong>${Number(loan.annualRate).toFixed(2)}%</strong></div>
        <div class="meta-item"><span>Disbursement date</span><strong>${formatDate(loan.disbursedDate)}</strong></div>
        <div class="meta-item"><span>Estimated outstanding principal</span><strong>${principalLabel}</strong></div>
      </div>
      <div class="detail-divider"></div>
      <h3 class="detail-section-title">Application journey</h3>
      ${renderMiniProgress(loan)}
      ${loan.status === 'Rejected' ? '<div class="workflow-warning">This application was rejected. No funds should be disbursed from this record.</div>' : ''}
      ${loan.status === 'Repaying' || loan.status === 'Closed' ? `<div class="detail-divider"></div><h3 class="detail-section-title">Repayment progress</h3><div class="payment-progress"><div class="payment-track"><div class="payment-fill" style="width:${progress}%"></div></div><span>${paid} of ${loan.tenureMonths} EMIs (${progress}%)</span></div><p style="font-size:10px;color:#8998a3;margin:8px 0 0">Each click on “Record next EMI” simulates one instalment for this demo.</p>` : ''}
      <div class="details-actions">
        ${isManager ? (action.action === 'closed' || action.action === 'rejected' ? `<button class="button button-secondary" type="button" disabled>${escapeHtml(action.label)}</button>` : `<button class="button button-primary" type="button" data-loan-action="${action.action}" data-loan-id="${escapeHtml(loan.id)}">${escapeHtml(action.label)} <span aria-hidden="true">→</span></button>`) : ''}
        ${canReject ? `<button class="button button-danger" type="button" data-loan-action="reject" data-loan-id="${escapeHtml(loan.id)}">Reject application</button>` : ''}
        <button class="button button-secondary push-right" type="button" data-close="detailsModal">Done</button>
      </div>`;
    openModal('detailsModal');
  }

  async function performLoanAction(id, actionName) {
    if (currentUser.role !== 'manager') return;
    const loan = loans.find((item) => item.id === id);
    if (!loan) return;

    if (actionName === 'reject') {
      const confirmed = window.confirm(`Reject application ${loan.id} for ${loan.applicant}?`);
      if (!confirmed) return;
    }

    try {
      const response = await fetch(`/api/loans/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ action: actionName })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not update this application.');
      await loadLoans();
      showDetails(id);
      showToast(actionName === 'reject' ? 'Application marked as rejected.' : `${loan.id} updated to ${result.loan.status}.`);
    } catch (requestError) {
      showToast(requestError.message, true);
    }
  }

  async function signIn(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const error = $('#loginError');
    error.hidden = true;
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ role: loginRole, username: formData.get('username'), password: formData.get('password') })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Sign-in failed.');
      currentUser = result.user;
      await loadLoans();
      showApplication();
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
    }
  }

  async function signOut() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      currentUser = null;
      loans = [];
      $('#loginForm').reset();
      showLogin();
    }
  }

  function exportJson() {
    const data = JSON.stringify({ loans }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `loandesk-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast('Loan data exported as JSON.');
  }

  function wireEvents() {
    $$('.role-option').forEach((button) => button.addEventListener('click', () => {
      loginRole = button.dataset.loginRole;
      $$('.role-option').forEach((option) => {
        const selected = option === button;
        option.classList.toggle('active', selected);
        option.setAttribute('aria-pressed', String(selected));
      });
      $('#demoCredentials').textContent = loginRole === 'manager' ? 'manager / manager123' : 'borrower / borrower123';
      $('#loginForm').reset();
      $('#loginError').hidden = true;
    }));
    $('#loginForm').addEventListener('submit', signIn);
    $('#logoutButton').addEventListener('click', signOut);
    $('#openApplicationButton').addEventListener('click', () => openModal('applicationModal'));
    $('#emptyNewButton').addEventListener('click', () => openModal('applicationModal'));
    $('#applicationForm').addEventListener('submit', createApplication);
    $('#searchInput').addEventListener('input', renderTable);
    $('#statusFilter').addEventListener('change', renderTable);
    $('#exportButton').addEventListener('click', exportJson);
    $('#helpButton').addEventListener('click', () => showToast('Open an application to view its details and available actions.'));

    document.addEventListener('click', (event) => {
      const viewButton = event.target.closest('[data-view-loan]');
      if (viewButton) {
        showDetails(viewButton.getAttribute('data-view-loan'));
        return;
      }
      const actionButton = event.target.closest('[data-loan-action]');
      if (actionButton) {
        performLoanAction(actionButton.getAttribute('data-loan-id'), actionButton.getAttribute('data-loan-action'));
        return;
      }
      const closeButton = event.target.closest('[data-close]');
      if (closeButton) {
        closeModal(closeButton.getAttribute('data-close'));
        return;
      }
      const backdrop = event.target.classList.contains('modal-backdrop') ? event.target : null;
      if (backdrop) closeModal(backdrop.id);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        $$('.modal-backdrop').forEach((modal) => { if (!modal.hidden) closeModal(modal.id); });
      }
    });
  }

  wireEvents();
  initialize();
})();
