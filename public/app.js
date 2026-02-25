// ===== DOM Elements =====
const screens = {
  title: document.getElementById('screen-title'),
  game: document.getElementById('screen-game'),
  result: document.getElementById('screen-result'),
  leaderboard: document.getElementById('screen-leaderboard')
};

const btnStart = document.getElementById('btn-start');
const btnScores = document.getElementById('btn-scores');
const btnBackTitle = document.getElementById('btn-back-title');
const btnRetry = document.getElementById('btn-retry');
const btnToScores = document.getElementById('btn-to-scores');
const btnBackFromScores = document.getElementById('btn-back-from-scores');
const gameForm = document.getElementById('game-form');
const loading = document.getElementById('loading');

// ===== Screen Navigation =====
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ===== Toast Notifications =====
function showToast(msg, duration = 4000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ===== Leaderboard Rendering =====
function renderLeaderboard(data, highlightDate) {
  const tbody = document.getElementById('leaderboard-body');
  tbody.innerHTML = '';
  
  if (!data.length) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="5" style="color:#555; padding:30px;">Aucun score pour le moment</td>`;
    tbody.appendChild(row);
    return;
  }

  data.forEach((entry, i) => {
    const row = document.createElement('tr');
    if (highlightDate && entry.date === highlightDate) {
      row.className = 'highlight';
    }
    const medals = ['👑', '🥈', '🥉'];
    const rank = i < 3 ? medals[i] : `${i + 1}`;
    row.innerHTML = `
      <td>${rank}</td>
      <td>${escapeHtml(entry.pseudo)}</td>
      <td>${escapeHtml(entry.villeDepart)} → ${escapeHtml(entry.villeArrivee)}</td>
      <td>${entry.nbRondPoints}</td>
      <td>${entry.distanceKm}</td>
    `;
    tbody.appendChild(row);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== API Calls =====
async function fetchLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    return await res.json();
  } catch {
    return [];
  }
}

async function submitChallenge(pseudo, villeDepart, villeArrivee) {
  const res = await fetch('/api/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pseudo, villeDepart, villeArrivee })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erreur serveur');
  return data;
}

// ===== Animated Counter =====
function animateNumber(el, target, duration = 1500) {
  const start = 0;
  const startTime = performance.now();
  
  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const ease = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + (target - start) * ease);
    el.textContent = current;
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ===== City Autocomplete =====
function setupAutocomplete(inputId, listId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let debounceTimer = null;
  let selectedIdx = -1;
  let currentItems = [];

  function hideList() {
    list.classList.remove('visible');
    list.innerHTML = '';
    currentItems = [];
    selectedIdx = -1;
  }

  function showResults(results) {
    list.innerHTML = '';
    currentItems = results;
    selectedIdx = -1;

    if (!results.length) {
      hideList();
      return;
    }

    results.forEach((r, i) => {
      const div = document.createElement('div');
      div.className = 'autocomplete-item';
      div.innerHTML = `${escapeHtml(r.name)}${r.department ? `<span class="ac-dept">${escapeHtml(r.department)}</span>` : ''}`;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent input blur
        input.value = r.name;
        hideList();
      });
      list.appendChild(div);
    });

    list.classList.add('visible');
  }

  function updateSelection() {
    const items = list.querySelectorAll('.autocomplete-item');
    items.forEach((el, i) => {
      el.classList.toggle('selected', i === selectedIdx);
    });
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(debounceTimer);

    if (q.length < 2) {
      hideList();
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/autocomplete?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        // Only show if input still matches (user might have typed more)
        if (input.value.trim().toLowerCase().startsWith(q.toLowerCase())) {
          showResults(data);
        }
      } catch {
        hideList();
      }
    }, 300);
  });

  input.addEventListener('keydown', (e) => {
    if (!list.classList.contains('visible')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, currentItems.length - 1);
      updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      updateSelection();
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      input.value = currentItems[selectedIdx].name;
      hideList();
    } else if (e.key === 'Escape') {
      hideList();
    }
  });

  input.addEventListener('blur', () => {
    // Delay to allow click on item
    setTimeout(hideList, 200);
  });
}

// Initialize autocomplete on both city fields
setupAutocomplete('ville-depart', 'ac-depart');
setupAutocomplete('ville-arrivee', 'ac-arrivee');

// ===== Event Handlers =====

// Title → Game
btnStart.addEventListener('click', () => {
  showScreen('game');
  // Restore pseudo from localStorage if available
  const saved = localStorage.getItem('gc_pseudo');
  if (saved) document.getElementById('pseudo').value = saved;
});

// Title → Leaderboard
btnScores.addEventListener('click', async () => {
  showScreen('leaderboard');
  const data = await fetchLeaderboard();
  renderLeaderboard(data);
});

// Game → Title
btnBackTitle.addEventListener('click', () => showScreen('title'));

// Result → Game
btnRetry.addEventListener('click', () => showScreen('game'));

// Result → Leaderboard
btnToScores.addEventListener('click', async () => {
  showScreen('leaderboard');
  const data = await fetchLeaderboard();
  renderLeaderboard(data, lastResultDate);
});

// Leaderboard → Title
btnBackFromScores.addEventListener('click', () => showScreen('title'));

// Track last result for highlighting
let lastResultDate = null;

// Form Submit
gameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const pseudo = document.getElementById('pseudo').value.trim();
  const villeDepart = document.getElementById('ville-depart').value.trim();
  const villeArrivee = document.getElementById('ville-arrivee').value.trim();

  if (!pseudo || !villeDepart || !villeArrivee) {
    showToast('Remplis tous les champs !');
    return;
  }

  // Save pseudo
  localStorage.setItem('gc_pseudo', pseudo);

  // Show loading
  loading.classList.remove('hidden');

  try {
    const result = await submitChallenge(pseudo, villeDepart, villeArrivee);
    lastResultDate = result.date;

    // Fill result screen
    document.getElementById('result-route').textContent = 
      `${result.villeDepart} → ${result.villeArrivee}`;
    document.getElementById('result-distance').textContent = result.distanceKm;
    document.getElementById('result-ratio').textContent = result.ratio;
    document.getElementById('result-rank').textContent = `#${result.rank}`;

    // Show result screen
    loading.classList.add('hidden');
    showScreen('result');

    // Animate the big number
    animateNumber(document.getElementById('result-count'), result.nbRondPoints);

  } catch (err) {
    loading.classList.add('hidden');
    showToast(err.message);
  }
});

// ===== Keyboard shortcuts =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && screens.title.classList.contains('active')) {
    btnStart.click();
  }
});

// ===== Preload leaderboard on title =====
(async () => {
  // Warm up
  await fetchLeaderboard();
})();
