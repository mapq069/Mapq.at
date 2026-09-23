(() => {
  const groups = {
    bikes: [['highlights/bikes-photo.jpg','Motorrad beim Event'],['DSC00931.jpg','Motorrad vor den Tiroler Bergen'],['DSC04406.jpg','Detail am Motorrad']],
    cars: [['highlights/cars-photo.jpg','Audi vor den Bergen'],['DSC04780.jpg','Audi in Tirol'],['DSC04993.jpg','Felgendetail'],['DSC07814.jpg','BMW im Abendlicht'],['DSC02961.jpg','Volkswagen-Innenraum']],
    outdoor: [['highlights/outdoor-photo.jpg','Wasserfall in den Bergen'],['DSC03082.jpg','Unterwegs am Wasserfall'],['DSC03159.jpg','Steine und Bergwald']],
    tiere: [['highlights/tiere-photo.jpg','Hund vor den Bergen bei Sonnenuntergang']]
  };
  const modal = document.createElement('dialog');
  modal.className = 'mapq-story';
  modal.setAttribute('aria-label','Foto-Highlights');
  modal.innerHTML = '<div class="story-bars" aria-hidden="true"></div><header><strong></strong><button type="button" class="story-close" aria-label="Highlights schließen">Schließen ×</button></header><figure class="story-figure"><img alt=""><figcaption></figcaption></figure><div class="story-controls"><button type="button" class="story-prev" aria-label="Vorheriges Foto">← Zurück</button><span class="story-count" aria-live="polite"></span><button type="button" class="story-next" aria-label="Nächstes Foto">Weiter →</button></div>';
  document.body.append(modal);
  let category, index = 0, trigger, oldOverflow;
  const photo = modal.querySelector('img');
  function render() {
    const list = groups[category], [src, alt] = list[index];
    photo.src = src; photo.alt = alt;
    modal.querySelector('strong').textContent = category;
    modal.querySelector('figcaption').textContent = alt;
    modal.querySelector('.story-count').textContent = `${index + 1} / ${list.length}`;
    modal.querySelector('.story-bars').replaceChildren(...list.map((_, i) => {
      const bar = document.createElement('span');
      if (i === index) bar.className = 'active';
      return bar;
    }));
    modal.querySelector('.story-prev').hidden = list.length === 1;
    modal.querySelector('.story-next').hidden = list.length === 1;
  }
  function move(amount) { index = (index + amount + groups[category].length) % groups[category].length; render(); }
  document.querySelectorAll('[data-highlight]').forEach(link => link.addEventListener('click', event => {
    if (typeof modal.showModal !== 'function') return;
    event.preventDefault(); trigger = link; category = link.dataset.highlight; index = 0;
    render(); oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; modal.showModal();
  }));
  modal.querySelector('.story-close').onclick = () => modal.close();
  modal.querySelector('.story-prev').onclick = () => move(-1);
  modal.querySelector('.story-next').onclick = () => move(1);
  modal.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); move(e.key === 'ArrowRight' ? 1 : -1); }
  });
  modal.addEventListener('close', () => { document.body.style.overflow = oldOverflow; trigger?.focus(); });
  let start;
  photo.addEventListener('touchstart', e => { start = e.touches.length === 1 ? [e.touches[0].clientX,e.touches[0].clientY] : null; },{passive:true});
  photo.addEventListener('touchend', e => {
    if (!start || !e.changedTouches.length) return;
    const dx=e.changedTouches[0].clientX-start[0],dy=e.changedTouches[0].clientY-start[1]; start=null;
    if(Math.abs(dx)>65 && Math.abs(dx)>Math.abs(dy)*1.5) move(dx<0 ? 1 : -1);
  },{passive:true});
  photo.addEventListener('touchcancel', () => { start=null; });
})();
