// ==UserScript==
// @name         Universal Text Highlighter
// @namespace    http://tampermonkey.net/
// @version      2026.09.10
// @description  Safari/iOS/macOS 및 Chromium/Android/Desktop 공용 텍스트 하이라이터
// @updateURL    https://raw.githubusercontent.com/zimza1abim/filter-userscripts/main/Userscripts/Universal%20Text%20Highlighter.js
// @downloadURL  https://raw.githubusercontent.com/zimza1abim/filter-userscripts/main/Userscripts/Universal%20Text%20Highlighter.js 
// @author       zimza1abim
// @match        *://*/*
// @grant        none
// @run-at       document-end
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  /* =========================================================
   * Config
   * ======================================================= */

  const COLORS = [
    '#FFF59D', // Yellow
    '#D1E8FF', // Blue
    '#FFD1D1', // Pink
    '#A5F1A7', // Green
    '#E6D5FF'  // Lavender
  ];

  const STORAGE_KEY = 'uth:lastColor';

  const UI_Z = 2147483647;
  const EDGE = 8;
  const GAP = 8;

  const SELECTION_DELAY = 100;
  const POINTER_SELECTION_DELAY = 80;
  const TOUCH_SELECTION_DELAY = 180;
  const REPOSITION_DELAY = 40;

  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const IS_IOS =
    /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /*
   * Android/iOS 네이티브 선택 메뉴가 선택 영역 위에 나타나는 경우가 많으므로
   * 위쪽으로 배치할 때 추가 간격 확보.
   */
  const NATIVE_MENU_GAP =
    IS_ANDROID ? 64 :
    IS_IOS ? 48 :
    8;

  /* =========================================================
   * State
   * ======================================================= */

  let host = null;
  let shadow = null;
  let wrapper = null;
  let palette = null;

  let savedRange = null;
  let lastSelectionRect = null;

  let selectionTimer = null;
  let repositionTimer = null;

  let interactingWithUI = false;
  let paletteVisible = false;

  /* =========================================================
   * Generic helpers
   * ======================================================= */

  const clamp = (value, min, max) =>
    Math.min(Math.max(value, min), max);

  const debounce = (fn, delay) => {
    let timer;

    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  };

  const getElementFromNode = (node) => {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE
      ? node
      : node.parentElement;
  };

  const isEditable = (node) => {
    const el = getElementFromNode(node);
    if (!el) return false;

    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement
    ) {
      return true;
    }

    return !!el.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
    );
  };

  const isForbiddenSelection = (selection) => {
    if (!selection || selection.rangeCount === 0) return true;
    if (selection.isCollapsed) return true;
    if (!selection.toString().trim()) return true;

    if (
      isEditable(selection.anchorNode) ||
      isEditable(selection.focusNode)
    ) {
      return true;
    }

    if (
      host &&
      (
        host.contains(selection.anchorNode) ||
        host.contains(selection.focusNode)
      )
    ) {
      return true;
    }

    return false;
  };

  const saveLastColor = (color) => {
    try {
      localStorage.setItem(STORAGE_KEY, color);
    } catch {}
  };

  const getLastColor = () => {
    try {
      return localStorage.getItem(STORAGE_KEY) || COLORS[0];
    } catch {
      return COLORS[0];
    }
  };

  const viewport = () => {
    const vv = window.visualViewport;

    if (vv) {
      return {
        left: vv.offsetLeft,
        top: vv.offsetTop,
        width: vv.width,
        height: vv.height
      };
    }

    return {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight
    };
  };

  /* =========================================================
   * Highlight helpers
   * ======================================================= */

  const isHighlight = (node) =>
    !!(
      node &&
      node.nodeType === Node.ELEMENT_NODE &&
      node.matches('mark[data-uth-highlight]')
    );

  const getHighlightColor = (mark) =>
    mark?.getAttribute('data-uth-color') ||
    mark?.style.backgroundColor ||
    mark?.style.background ||
    '';

  const createMark = (color) => {
    const mark = document.createElement('mark');

    mark.setAttribute('data-uth-highlight', '');
    mark.setAttribute('data-uth-color', color);

    Object.assign(mark.style, {
      background: color,
      color: 'inherit',
      borderRadius: '3px',
      padding: '0 2px',
      boxDecorationBreak: 'clone',
      WebkitBoxDecorationBreak: 'clone'
    });

    return mark;
  };

  const unwrap = (element) => {
    if (!element?.parentNode) return;

    const parent = element.parentNode;

    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element);
    }

    element.remove();
    parent.normalize?.();
  };

  const rangeIntersectsNode = (range, node) => {
    try {
      if (typeof range.intersectsNode === 'function') {
        return range.intersectsNode(node);
      }

      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(node);

      return (
        range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0
      );
    } catch {
      return false;
    }
  };

  /*
   * 선택 범위 내부의 기존 하이라이트를 먼저 제거한다.
   *
   * 이렇게 하면:
   * - 하이라이트 위에 하이라이트 중첩
   * - span/mark 무한 중첩
   * - 색상 변경 실패
   * 문제를 크게 줄일 수 있다.
   */
  const unwrapIntersectingHighlights = (range) => {
    const root =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;

    if (!root) return;

    const candidates = [];

    if (isHighlight(root)) {
      candidates.push(root);
    }

    root
      .querySelectorAll?.('mark[data-uth-highlight]')
      .forEach((mark) => {
        if (rangeIntersectsNode(range, mark)) {
          candidates.push(mark);
        }
      });

    /*
     * 내부 요소부터 제거해야 DOM 구조 손상을 줄일 수 있음.
     */
    candidates
      .sort((a, b) => {
        if (a.contains(b)) return 1;
        if (b.contains(a)) return -1;
        return 0;
      })
      .forEach(unwrap);
  };

  const mergeAdjacentHighlights = (root = document.body) => {
    if (!root?.querySelectorAll) return;

    const marks = [...root.querySelectorAll('mark[data-uth-highlight]')];

    for (const mark of marks) {
      if (!mark.isConnected) continue;

      let next = mark.nextSibling;

      /*
       * 빈 텍스트 노드는 무시.
       */
      while (
        next &&
        next.nodeType === Node.TEXT_NODE &&
        !next.nodeValue
      ) {
        const remove = next;
        next = next.nextSibling;
        remove.remove();
      }

      if (
        isHighlight(next) &&
        getHighlightColor(next) === getHighlightColor(mark)
      ) {
        while (next.firstChild) {
          mark.appendChild(next.firstChild);
        }

        next.remove();
      }
    }
  };

  /*
   * surroundContents()는 부분 선택된 Element가 포함되면
   * InvalidStateError가 발생하므로 extractContents() 기반 fallback 사용.
   */
  const wrapRange = (range, color) => {
    if (!range || range.collapsed) return false;

    const mark = createMark(color);

    try {
      range.surroundContents(mark);
      return true;
    } catch {}

    try {
      const fragment = range.extractContents();

      if (!fragment.textContent?.trim()) {
        return false;
      }

      mark.appendChild(fragment);
      range.insertNode(mark);

      return true;
    } catch (error) {
      console.warn('[Universal Text Highlighter]', error);
      return false;
    }
  };

  /* =========================================================
   * Range preservation
   * ======================================================= */

  const saveSelection = () => {
    const selection = window.getSelection();

    if (isForbiddenSelection(selection)) {
      savedRange = null;
      return false;
    }

    try {
      savedRange = selection.getRangeAt(0).cloneRange();
      return true;
    } catch {
      savedRange = null;
      return false;
    }
  };

  const restoreSelection = () => {
    if (!savedRange) return null;

    const selection = window.getSelection();

    if (!selection) return null;

    try {
      selection.removeAllRanges();
      selection.addRange(savedRange);

      return savedRange;
    } catch {
      return null;
    }
  };

  const clearSelection = () => {
    try {
      window.getSelection()?.removeAllRanges();
    } catch {}

    savedRange = null;
    lastSelectionRect = null;
  };

  /* =========================================================
   * Selection rect
   * ======================================================= */

  /*
   * 여러 줄 선택 시 getBoundingClientRect() 전체 박스를 그대로 쓰면
   * 팔레트 위치가 이상해질 수 있으므로 마지막 visible rect를 기준으로 사용.
   *
   * 선택 방향과 관계없이 모바일에서 손가락이 끝난 부분 근처에 배치되는
   * 결과가 일반적으로 가장 자연스럽다.
   */
  const getSelectionRect = (range = null) => {
    const selection = window.getSelection();

    if (!range) {
      if (!selection || selection.rangeCount === 0) return null;

      try {
        range = selection.getRangeAt(0);
      } catch {
        return null;
      }
    }

    let rects;

    try {
      rects = [...range.getClientRects()].filter(
        rect => rect.width > 0 && rect.height > 0
      );
    } catch {
      rects = [];
    }

    if (rects.length) {
      /*
       * 마지막 줄 rect 사용.
       */
      return rects[rects.length - 1];
    }

    try {
      const rect = range.getBoundingClientRect();

      if (rect.width > 0 || rect.height > 0) {
        return rect;
      }
    } catch {}

    return null;
  };

  /* =========================================================
   * Shadow DOM UI
   * ======================================================= */

  const createUI = () => {
    if (host) return;

    host = document.createElement('div');

    Object.assign(host.style, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      width: '0',
      height: '0',
      pointerEvents: 'none',
      zIndex: String(UI_Z)
    });

    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');

    style.textContent = `
      :host {
        all: initial;
      }

      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }

      .uth-wrapper {
        position: fixed;
        display: none;
        pointer-events: auto;
        max-width: calc(100vw - 16px);
        z-index: ${UI_Z};
        touch-action: manipulation;
        -webkit-user-select: none;
        user-select: none;
      }

      .uth-palette {
        display: flex;
        align-items: center;
        gap: 8px;

        padding: 8px;

        background: rgba(255, 255, 255, 0.97);
        border: 1px solid rgba(0, 0, 0, 0.12);
        border-radius: 13px;

        box-shadow:
          0 4px 14px rgba(0, 0, 0, 0.16),
          0 1px 3px rgba(0, 0, 0, 0.08);

        -webkit-backdrop-filter: blur(14px);
        backdrop-filter: blur(14px);

        overflow-x: auto;
        scrollbar-width: none;
      }

      .uth-palette::-webkit-scrollbar {
        display: none;
      }

      .uth-button {
        position: relative;
        flex: 0 0 auto;

        width: 34px;
        height: 34px;

        margin: 0;
        padding: 0;

        border: 0;
        border-radius: 50%;

        appearance: none;
        -webkit-appearance: none;

        cursor: pointer;
        touch-action: manipulation;

        box-shadow:
          inset 0 0 0 1px rgba(0, 0, 0, 0.08),
          0 1px 3px rgba(0, 0, 0, 0.15);

        transition:
          transform 80ms ease,
          box-shadow 80ms ease;
      }

      .uth-button:active {
        transform: scale(0.9);
      }

      .uth-button[data-selected="true"]::after {
        content: "";

        position: absolute;
        inset: -3px;

        border: 2px solid rgba(80, 80, 80, 0.75);
        border-radius: inherit;

        pointer-events: none;
      }

      .uth-custom {
        display: flex;
        align-items: center;
        justify-content: center;

        background:
          conic-gradient(
            #ff5f57,
            #febc2e,
            #28c840,
            #4da3ff,
            #a970ff,
            #ff5f57
          );

        font-size: 0;
      }

      .uth-custom::before {
        content: "";

        width: 16px;
        height: 16px;

        background: rgba(255, 255, 255, 0.95);
        border-radius: 50%;
      }

      @media (hover: hover) {
        .uth-button:hover {
          transform: scale(1.06);
        }
      }

      @media (prefers-color-scheme: dark) {
        .uth-palette {
          background: rgba(30, 30, 32, 0.96);
          border-color: rgba(255, 255, 255, 0.16);

          box-shadow:
            0 4px 16px rgba(0, 0, 0, 0.35),
            0 1px 3px rgba(0, 0, 0, 0.3);
        }

        .uth-button {
          box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.12),
            0 1px 3px rgba(0, 0, 0, 0.35);
        }

        .uth-button[data-selected="true"]::after {
          border-color: rgba(255, 255, 255, 0.85);
        }
      }
    `;

    wrapper = document.createElement('div');
    wrapper.className = 'uth-wrapper';

    palette = document.createElement('div');
    palette.className = 'uth-palette';

    const lastColor = getLastColor();

    for (const color of COLORS) {
      const button = document.createElement('button');

      button.type = 'button';
      button.className = 'uth-button';
      button.style.background = color;
      button.setAttribute('aria-label', `Highlight ${color}`);
      button.dataset.color = color;

      if (color.toUpperCase() === lastColor.toUpperCase()) {
        button.dataset.selected = 'true';
      }

      /*
       * pointerdown 단계에서 preventDefault 해야 Safari/Chromium이
       * 텍스트 selection을 버튼 클릭 때문에 먼저 없애지 않는다.
       */
      button.addEventListener(
        'pointerdown',
        event => {
          interactingWithUI = true;
          event.preventDefault();
          event.stopPropagation();
        },
        { passive: false }
      );

      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();

        applyHighlight(color);

        interactingWithUI = false;
      });

      palette.appendChild(button);
    }

    /*
     * Custom color.
     *
     * <input type=color> 자체를 보이게 만들 경우
     * iOS Safari/Android Chromium 간 UI 편차가 커서 숨겨서 사용.
     */
    const customButton = document.createElement('button');
    customButton.type = 'button';
    customButton.className = 'uth-button uth-custom';
    customButton.setAttribute('aria-label', 'Custom highlight color');

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = /^#[0-9a-f]{6}$/i.test(lastColor)
      ? lastColor
      : COLORS[0];

    Object.assign(colorInput.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none'
    });

    customButton.addEventListener(
      'pointerdown',
      event => {
        interactingWithUI = true;

        /*
         * 여기에서는 preventDefault하지 않음.
         * 일부 iOS Safari 버전에서 color input picker가
         * preventDefault 이후 열리지 않는 문제 회피.
         */
        event.stopPropagation();

        saveSelection();
      },
      { passive: false }
    );

    customButton.addEventListener('click', event => {
      event.stopPropagation();

      try {
        colorInput.click();
      } catch {}
    });

    colorInput.addEventListener('input', () => {
      applyHighlight(colorInput.value);
      interactingWithUI = false;
    });

    colorInput.addEventListener('change', () => {
      interactingWithUI = false;
    });

    palette.append(customButton, colorInput);
    wrapper.appendChild(palette);
    shadow.append(style, wrapper);
  };

  /* =========================================================
   * Palette positioning
   * ======================================================= */

  const measurePalette = () => {
    if (!wrapper) return { width: 0, height: 0 };

    const previousDisplay = wrapper.style.display;
    const previousVisibility = wrapper.style.visibility;

    wrapper.style.visibility = 'hidden';
    wrapper.style.display = 'block';

    const rect = wrapper.getBoundingClientRect();

    wrapper.style.display = previousDisplay;
    wrapper.style.visibility = previousVisibility;

    return {
      width: rect.width,
      height: rect.height
    };
  };

  const placePalette = (targetRect) => {
    if (!wrapper || !targetRect) return;

    const vp = viewport();
    const size = measurePalette();

    const minLeft = vp.left + EDGE;
    const maxLeft = Math.max(
      minLeft,
      vp.left + vp.width - size.width - EDGE
    );

    const minTop = vp.top + EDGE;
    const maxTop = Math.max(
      minTop,
      vp.top + vp.height - size.height - EDGE
    );

    let left =
      targetRect.left +
      (targetRect.width - size.width) / 2;

    left = clamp(left, minLeft, maxLeft);

    /*
     * 1. 아래 우선
     * 2. 위
     * 3. 오른쪽
     * 4. 왼쪽
     * 5. 화면 내부 강제 clamp
     */
    let top;

    const below =
      targetRect.bottom +
      GAP;

    const above =
      targetRect.top -
      GAP -
      NATIVE_MENU_GAP -
      size.height;

    const canBelow =
      below + size.height <=
      vp.top + vp.height - EDGE;

    const canAbove =
      above >= vp.top + EDGE;

    if (canBelow) {
      top = below;
    } else if (canAbove) {
      top = above;
    } else {
      const right =
        targetRect.right +
        GAP;

      const leftSide =
        targetRect.left -
        GAP -
        size.width;

      top =
        targetRect.top +
        (targetRect.height - size.height) / 2;

      top = clamp(top, minTop, maxTop);

      if (
        right + size.width <=
        vp.left + vp.width - EDGE
      ) {
        left = right;
      } else if (leftSide >= vp.left + EDGE) {
        left = leftSide;
      } else {
        /*
         * 공간이 아예 없으면 선택 영역 아래를 기준으로
         * visual viewport 내부에 강제로 집어넣는다.
         */
        top = clamp(below, minTop, maxTop);
        left = clamp(left, minLeft, maxLeft);
      }
    }

    wrapper.style.left = `${Math.round(left)}px`;
    wrapper.style.top = `${Math.round(top)}px`;
    wrapper.style.display = 'block';

    paletteVisible = true;
  };

  const showPalette = () => {
    if (!savedRange) return;

    const rect =
      getSelectionRect(savedRange) ||
      lastSelectionRect;

    if (!rect) {
      hidePalette();
      return;
    }

    lastSelectionRect = rect;
    placePalette(rect);
  };

  const hidePalette = () => {
    if (!wrapper) return;

    wrapper.style.display = 'none';
    paletteVisible = false;
  };

  /* =========================================================
   * Palette state
   * ======================================================= */

  const updateSelectedColor = (color) => {
    if (!palette) return;

    palette
      .querySelectorAll('.uth-button[data-color]')
      .forEach(button => {
        button.dataset.selected =
          button.dataset.color.toUpperCase() ===
          color.toUpperCase()
            ? 'true'
            : 'false';
      });
  };

  /* =========================================================
   * Apply highlight
   * ======================================================= */

  const applyHighlight = (color) => {
    if (!color) return;

    /*
     * 버튼 클릭 순간 Selection API의 Range가 사라질 수 있으므로
     * 반드시 저장해 둔 cloneRange를 우선 사용.
     */
    let range = savedRange?.cloneRange();

    if (!range) {
      const selection = window.getSelection();

      if (
        !selection ||
        selection.rangeCount === 0 ||
        !selection.toString().trim()
      ) {
        hidePalette();
        return;
      }

      try {
        range = selection.getRangeAt(0).cloneRange();
      } catch {
        return;
      }
    }

    if (range.collapsed) {
      hidePalette();
      return;
    }

    const startEl = getElementFromNode(range.startContainer);
    const endEl = getElementFromNode(range.endContainer);

    if (
      isEditable(startEl) ||
      isEditable(endEl)
    ) {
      hidePalette();
      return;
    }

    /*
     * 기존 UTH 하이라이트를 선택해서 다른 색을 누르면
     * 중첩하지 않고 해당 영역 색상이 교체된다.
     */
    try {
      unwrapIntersectingHighlights(range);
    } catch (error) {
      console.warn(
        '[Universal Text Highlighter] Failed to normalize existing highlights:',
        error
      );
    }

    /*
     * DOM 변경으로 기존 Range boundary가 무효화될 수 있으므로
     * 가능한 경우 현재 Selection에서 다시 가져온다.
     */
    let workingRange = range;

    const currentSelection = window.getSelection();

    if (
      currentSelection &&
      currentSelection.rangeCount > 0 &&
      currentSelection.toString().trim()
    ) {
      try {
        workingRange = currentSelection.getRangeAt(0).cloneRange();
      } catch {}
    }

    const success = wrapRange(workingRange, color);

    if (success) {
      mergeAdjacentHighlights(
        workingRange.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? workingRange.commonAncestorContainer
          : workingRange.commonAncestorContainer.parentElement
      );

      saveLastColor(color);
      updateSelectedColor(color);
    }

    clearSelection();
    hidePalette();

    interactingWithUI = false;
  };

  /* =========================================================
   * Selection watcher
   * ======================================================= */

  const processSelection = () => {
    if (interactingWithUI) return;

    const selection = window.getSelection();

    if (isForbiddenSelection(selection)) {
      /*
       * 팔레트를 클릭하는 과정에서 selectionchange가 발생하는 경우
       * 이미 저장한 Range가 있으면 바로 지우지 않는다.
       */
      if (!interactingWithUI) {
        hidePalette();
      }

      return;
    }

    let range;

    try {
      range = selection.getRangeAt(0);
    } catch {
      hidePalette();
      return;
    }

    const rect = getSelectionRect(range);

    if (!rect) {
      hidePalette();
      return;
    }

    try {
      savedRange = range.cloneRange();
    } catch {
      return;
    }

    lastSelectionRect = rect;

    /*
     * 네이티브 메뉴가 올라오는 동일 프레임에서 팔레트를 표시하면
     * iOS Safari가 selection을 다시 계산하면서 UI가 튀는 경우가 있어
     * requestAnimationFrame으로 한 프레임 분리.
     */
    requestAnimationFrame(() => {
      if (savedRange) {
        showPalette();
      }
    });
  };

  const scheduleSelectionCheck = (delay = SELECTION_DELAY) => {
    clearTimeout(selectionTimer);

    selectionTimer = setTimeout(
      processSelection,
      delay
    );
  };

  /* =========================================================
   * Reposition
   * ======================================================= */

  const reposition = () => {
    if (!paletteVisible || !savedRange) return;

    clearTimeout(repositionTimer);

    repositionTimer = setTimeout(() => {
      const rect = getSelectionRect(savedRange);

      if (rect) {
        lastSelectionRect = rect;
        placePalette(rect);
      } else if (lastSelectionRect) {
        placePalette(lastSelectionRect);
      }
    }, REPOSITION_DELAY);
  };

  /* =========================================================
   * Events
   * ======================================================= */

  const bindEvents = () => {
    document.addEventListener(
      'selectionchange',
      () => {
        if (!interactingWithUI) {
          scheduleSelectionCheck();
        }
      },
      { passive: true }
    );

    /*
     * Desktop mouse + Android Pointer Events.
     */
    document.addEventListener(
      'pointerup',
      event => {
        if (host && event.composedPath?.().includes(host)) {
          return;
        }

        scheduleSelectionCheck(
          event.pointerType === 'touch'
            ? TOUCH_SELECTION_DELAY
            : POINTER_SELECTION_DELAY
        );
      },
      { passive: true }
    );

    /*
     * 구형 iOS Safari fallback.
     */
    document.addEventListener(
      'touchend',
      event => {
        if (host && event.composedPath?.().includes(host)) {
          return;
        }

        scheduleSelectionCheck(
          TOUCH_SELECTION_DELAY
        );
      },
      { passive: true }
    );

    document.addEventListener(
      'mouseup',
      event => {
        if (host && event.composedPath?.().includes(host)) {
          return;
        }

        scheduleSelectionCheck(
          POINTER_SELECTION_DELAY
        );
      },
      { passive: true }
    );

    /*
     * 외부를 새로 누르면 팔레트 닫기.
     *
     * selection 시작 직후 바로 닫아버리지 않도록
     * savedRange 자체는 즉시 제거하지 않는다.
     */
    document.addEventListener(
      'pointerdown',
      event => {
        const path =
          typeof event.composedPath === 'function'
            ? event.composedPath()
            : [];

        if (host && path.includes(host)) {
          interactingWithUI = true;
          return;
        }

        interactingWithUI = false;

        if (paletteVisible) {
          hidePalette();
        }
      },
      { capture: true, passive: true }
    );

    /*
     * ESC: 데스크톱에서 즉시 닫기.
     */
    document.addEventListener(
      'keydown',
      event => {
        if (event.key === 'Escape') {
          clearSelection();
          hidePalette();
        }
      },
      { passive: true }
    );

    /*
     * 주소창 축소/확장, pinch zoom, 회전, resize 대응.
     */
    window.addEventListener(
      'resize',
      reposition,
      { passive: true }
    );

    window.addEventListener(
      'scroll',
      reposition,
      { passive: true, capture: true }
    );

    window.addEventListener(
      'orientationchange',
      reposition,
      { passive: true }
    );

    if (window.visualViewport) {
      window.visualViewport.addEventListener(
        'resize',
        reposition,
        { passive: true }
      );

      window.visualViewport.addEventListener(
        'scroll',
        reposition,
        { passive: true }
      );
    }
  };

  /* =========================================================
   * Dynamic page / SPA protection
   * ======================================================= */

  /*
   * SPA가 documentElement/body를 교체하거나 UI host를 날리는 드문 경우
   * 자동 복구.
   */
  const installHostGuard = () => {
    if (!document.documentElement) return;

    const observer = new MutationObserver(() => {
      if (!host?.isConnected) {
        host = null;
        shadow = null;
        wrapper = null;
        palette = null;

        createUI();
      }
    });

    observer.observe(document.documentElement, {
      childList: true
    });
  };

  /* =========================================================
   * Init
   * ======================================================= */

  const init = () => {
    if (
      !document.documentElement ||
      !document.body
    ) {
      return;
    }

    createUI();
    bindEvents();
    installHostGuard();
  };

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      init,
      { once: true }
    );
  } else {
    init();
  }
})();