// 검색 가능한 언어 콤보박스 + 페이지 UI 다국어 처리 공용 유틸

async function fetchLanguages(target) {
  const res = await fetch(`/api/languages?target=${encodeURIComponent(target)}`);
  if (!res.ok) throw new Error(`언어 목록 조회 실패 (${res.status})`);
  return res.json();
}

async function fetchUiStrings(target) {
  const res = await fetch(`/api/ui-strings?target=${encodeURIComponent(target)}`);
  if (!res.ok) throw new Error(`UI 문자열 번역 실패 (${res.status})`);
  return res.json();
}

function applyUiStrings(strings) {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (strings[key] !== undefined) el.textContent = strings[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (strings[key] !== undefined) el.placeholder = strings[key];
  });
  if (strings.speakerTitle && document.body.dataset.page === 'speaker') {
    document.title = strings.speakerTitle;
  }
  if (strings.listenerTitle && document.body.dataset.page === 'listener') {
    document.title = strings.listenerTitle;
  }
}

// root: 콤보박스를 채워 넣을 빈 컨테이너 엘리먼트
// onSelect: (lang: {code, name}) => void
function createLanguageCombobox(root, onSelect) {
  root.classList.add('lang-combo');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lang-combo-input';
  input.autocomplete = 'off';

  const list = document.createElement('div');
  list.className = 'lang-combo-list';
  list.hidden = true;

  root.appendChild(input);
  root.appendChild(list);

  let languages = [];
  let filtered = [];
  let activeIndex = -1;
  let noResultsText = 'No results';

  function render() {
    list.innerHTML = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lang-combo-empty';
      empty.textContent = noResultsText;
      list.appendChild(empty);
      return;
    }

    filtered.forEach((lang, i) => {
      const item = document.createElement('div');
      item.className = 'lang-combo-item' + (i === activeIndex ? ' active' : '');
      item.textContent = lang.name;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        select(lang);
      });
      list.appendChild(item);
    });
  }

  function filterList(query) {
    const q = query.trim().toLowerCase();
    filtered = q
      ? languages.filter(
          (l) => l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)
        )
      : languages;
    activeIndex = -1;
    render();
  }

  function open() {
    list.hidden = false;
  }

  function close() {
    list.hidden = true;
  }

  function select(lang) {
    input.value = lang.name;
    close();
    if (onSelect) onSelect(lang);
  }

  input.addEventListener('focus', () => {
    filterList(input.value);
    open();
  });

  input.addEventListener('input', () => {
    filterList(input.value);
    open();
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && filtered[activeIndex]) select(filtered[activeIndex]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) close();
  });

  return {
    setLanguages(list_) {
      languages = list_;
      filtered = list_;
    },
    setPlaceholder(text) {
      input.placeholder = text;
    },
    setNoResultsText(text) {
      noResultsText = text;
    },
    setDisplayValue(text) {
      input.value = text;
    },
    setEnabled(enabled) {
      input.disabled = !enabled;
    },
  };
}

// container: 스크롤 가능한 로그 컨테이너 엘리먼트
// 확정된 줄은 누적되어 아래로 쌓이고, 잠정 텍스트는 항상 로그 맨 아래에 별도로 표시되다가
// 확정되면 로그에 편입되고 잠정 표시는 사라짐. 내용이 갱신될 때마다 자동으로 맨 아래로 스크롤.
//
// options.editable: true면 각 확정 줄에 연필 아이콘을 붙여 3초간 인라인 수정을 허용
// options.editWindowMs: 수정 가능 시간(기본 3000ms)
// options.onEdit: (lineId, newText) => void, 사용자가 수정을 확정했을 때 호출
// options.placeholderI18nKey: 내용이 하나도 없을 때 같은 박스 안에 보여줄 안내 문구의 data-i18n 키
//   (applyUiStrings가 기존 [data-i18n] 갱신 로직으로 자동으로 번역해줌). 내용이 생기면 자동으로 사라지고
//   다시는 나타나지 않다가, clear() 호출 시에만 재등장.
function createTranscriptLog(container, options = {}) {
  container.classList.add('transcript-log');

  const editable = !!options.editable;
  const editWindowMs = options.editWindowMs || 3000;
  const onEdit = options.onEdit;

  let placeholderEl = null;
  let hasContent = false;
  let latestFinalLine = null; // 가장 최근 확정 줄 (페이지에서 .latest 클래스로 시각적 위계를 줄 때 사용)

  if (options.placeholderI18nKey) {
    placeholderEl = document.createElement('div');
    placeholderEl.className = 'transcript-log-placeholder';
    placeholderEl.setAttribute('data-i18n', options.placeholderI18nKey);
    container.appendChild(placeholderEl);
  }

  const interimEl = document.createElement('div');
  interimEl.className = 'transcript-line interim';
  container.appendChild(interimEl);

  function markHasContent() {
    if (hasContent || !placeholderEl) return;
    hasContent = true;
    placeholderEl.hidden = true;
  }

  function scrollToBottom() {
    container.scrollTop = container.scrollHeight;
  }

  function startEdit(line, textSpan, editIcon) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'transcript-edit-input';
    input.value = textSpan.textContent;

    line.replaceChild(input, textSpan);
    editIcon.remove();
    input.focus();
    input.select();

    function confirmEdit() {
      const newText = input.value.trim();
      if (input.parentNode === line) line.replaceChild(textSpan, input);
      if (newText && newText !== textSpan.textContent) {
        textSpan.textContent = newText;
        if (onEdit) onEdit(line.dataset.lineId, newText);
      }
    }

    function cancelEdit() {
      if (input.parentNode === line) line.replaceChild(textSpan, input);
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    });
    input.addEventListener('blur', confirmEdit);
  }

  return {
    updateInterim(text) {
      if (text) markHasContent();
      interimEl.textContent = text;
      scrollToBottom();
    },
    // id: 서버가 부여한 확정 문장 식별자(있으면 이후 replaceFinal로 자리 유지 교체 가능)
    commitFinal(text, id) {
      if (text) markHasContent();
      interimEl.textContent = '';

      if (!text) {
        scrollToBottom();
        return;
      }

      const line = document.createElement('div');
      line.className = 'transcript-line final';
      if (id) line.dataset.lineId = id;

      const textSpan = document.createElement('span');
      textSpan.className = 'transcript-text';
      textSpan.textContent = text;
      line.appendChild(textSpan);

      if (editable && id) {
        const editIcon = document.createElement('button');
        editIcon.type = 'button';
        editIcon.className = 'transcript-edit-icon';
        editIcon.title = 'Edit';
        editIcon.textContent = '✏️';
        editIcon.addEventListener('click', () => startEdit(line, textSpan, editIcon));
        line.appendChild(editIcon);

        setTimeout(() => {
          if (editIcon.isConnected) {
            editIcon.disabled = true;
            editIcon.classList.add('expired');
          }
        }, editWindowMs);
      }

      container.insertBefore(line, interimEl);

      // 가장 최근 확정 줄에만 .latest를 표시 (페이지 CSS가 원하면 이 줄만 다르게 강조 가능)
      if (latestFinalLine) latestFinalLine.classList.remove('latest');
      line.classList.add('latest');
      latestFinalLine = line;

      scrollToBottom();
    },
    // 이미 표시된 확정 줄을 id로 찾아 자리는 유지한 채 텍스트만 교체. 찾았으면 true, 없으면 false.
    replaceFinal(id, text) {
      if (!id) return false;
      const line = container.querySelector(`.transcript-line.final[data-line-id="${CSS.escape(id)}"]`);
      if (!line) return false;
      const textSpan = line.querySelector('.transcript-text');
      if (textSpan) textSpan.textContent = text;
      return true;
    },
    clear() {
      container.querySelectorAll('.transcript-line.final').forEach((el) => el.remove());
      interimEl.textContent = '';
      hasContent = false;
      latestFinalLine = null;
      if (placeholderEl) placeholderEl.hidden = false;
    },
  };
}
