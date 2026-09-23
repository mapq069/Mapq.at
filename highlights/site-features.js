(() => {
  const progress = document.createElement('div');
  progress.className = 'mapq-scroll-progress';
  progress.setAttribute('aria-hidden', 'true');
  progress.append(document.createElement('span'));
  document.body.prepend(progress);

  const progressBar = progress.firstElementChild;
  let scrollFrame = 0;

  function updateProgress() {
    scrollFrame = 0;
    const available = document.documentElement.scrollHeight - window.innerHeight;
    const amount = available > 0 ? Math.min(1, Math.max(0, window.scrollY / available)) : 0;
    progressBar.style.transform = `scaleX(${amount})`;
  }

  function requestProgressUpdate() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(updateProgress);
  }

  addEventListener('scroll', requestProgressUpdate, { passive: true });
  addEventListener('resize', requestProgressUpdate, { passive: true });
  updateProgress();

  const grid = document.querySelector('.portfolio-grid');
  if (!grid) return;

  const figures = [...grid.querySelectorAll('figure')];
  if (!figures.length) return;

  const storageKey = 'mapq-favorites-v1';
  let favorites = new Set();

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) favorites = new Set(saved.filter(item => typeof item === 'string'));
  } catch {}

  function photoKey(link) {
    try {
      return new URL(link.href, location.href).pathname.replace(/\/{2,}/g, '/');
    } catch {
      return link.getAttribute('href') || '';
    }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...favorites]));
    } catch {}
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'mapq-favorites-toolbar';

  const count = document.createElement('span');
  count.className = 'mapq-favorites-count';
  count.setAttribute('aria-live', 'polite');

  const filterButton = document.createElement('button');
  filterButton.className = 'mapq-favorites-filter';
  filterButton.type = 'button';
  filterButton.textContent = 'Nur Favoriten';
  filterButton.setAttribute('aria-pressed', 'false');

  toolbar.append(count, filterButton);
  grid.before(toolbar);

  const empty = document.createElement('p');
  empty.className = 'mapq-favorites-empty';
  empty.textContent = 'Du hast in diesem Highlight noch keine Favoriten gespeichert.';
  empty.hidden = true;
  grid.append(empty);

  let filterActive = false;
  let currentKey = '';

  const dialog = document.createElement('dialog');
  dialog.className = 'mapq-photo-view';
  dialog.setAttribute('aria-label', 'Foto in Vollbild');
  dialog.innerHTML = '<div class="mapq-photo-view-controls"><button class="mapq-photo-view-favorite" type="button" aria-pressed="false">♡ Favorit</button><button class="mapq-photo-view-close" type="button">Schließen ×</button></div><div class="mapq-photo-view-stage"><img alt=""></div>';
  document.body.append(dialog);

  const dialogImage = dialog.querySelector('img');
  const dialogFavorite = dialog.querySelector('.mapq-photo-view-favorite');

  function updateDialogFavorite() {
    const active = favorites.has(currentKey);
    dialogFavorite.setAttribute('aria-pressed', String(active));
    dialogFavorite.textContent = active ? '♥ Favorit' : '♡ Favorit';
  }

  function updateView() {
    let pageFavorites = 0;

    figures.forEach(figure => {
      const key = figure.dataset.favoriteKey;
      const active = favorites.has(key);
      const button = figure.querySelector('.mapq-favorite-button');

      figure.classList.toggle('is-favorite', active);
      figure.classList.toggle('mapq-favorite-hidden', filterActive && !active);
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', active ? 'Aus Favoriten entfernen' : 'Als Favorit speichern');
      button.textContent = active ? '♥' : '♡';

      if (active) pageFavorites += 1;
    });

    count.textContent = pageFavorites === 1 ? '1 Favorit' : `${pageFavorites} Favoriten`;
    empty.hidden = !(filterActive && pageFavorites === 0);
    updateDialogFavorite();
  }

  function toggleFavorite(key) {
    if (favorites.has(key)) favorites.delete(key);
    else favorites.add(key);
    saveFavorites();
    updateView();
  }

  let audioContext;

  function playShutterSound() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    audioContext ||= new AudioContextClass();
    if (audioContext.state === 'suspended') audioContext.resume();

    const createClick = (delay, pitch, volume) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + delay;

      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(pitch, start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(65, pitch * .45), start + .045);
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + .004);
      gain.gain.exponentialRampToValueAtTime(.0001, start + .055);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + .06);
    };

    createClick(0, 220, .035);
    createClick(.065, 150, .025);
  }

  figures.forEach(figure => {
    const link = figure.querySelector('a[href]');
    const image = link?.querySelector('img');
    if (!link || !image) return;

    const key = photoKey(link);
    figure.dataset.favoriteKey = key;

    const button = document.createElement('button');
    button.className = 'mapq-favorite-button';
    button.type = 'button';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleFavorite(key);
    });
    figure.append(button);

    link.addEventListener('click', event => {
      if (typeof dialog.showModal !== 'function') return;
      event.preventDefault();
      playShutterSound();
      currentKey = key;
      dialogImage.src = link.href;
      dialogImage.alt = image.alt || 'MAPQ Fotografie';
      updateDialogFavorite();
      dialog.showModal();
    });
  });

  filterButton.addEventListener('click', () => {
    filterActive = !filterActive;
    filterButton.setAttribute('aria-pressed', String(filterActive));
    filterButton.textContent = filterActive ? 'Alle Bilder' : 'Nur Favoriten';
    updateView();
  });

  dialogFavorite.addEventListener('click', () => {
    if (currentKey) toggleFavorite(currentKey);
  });

  dialog.querySelector('.mapq-photo-view-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });

  updateView();
})();
