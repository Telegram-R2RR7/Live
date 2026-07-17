/* ══════════════════════════════════════════════════════════════
   PlayerEngine
   محرك تشغيل موحّد يدعم:
     - HLS (m3u8)      عبر hls.js أو التشغيل الأصلي (Safari/iOS)
     - MPEG-TS خام (.ts) عبر mpegts.js
     - روابط http عبر بروكسي (لحل مشاكل Mixed Content و CORS)
     - Fallback تلقائي بين مستويات الجودة عند الفشل
     - إعادة اتصال تلقائية عند انقطاع الشبكة
     - استرجاع أخطاء الميديا (recoverMediaError)
     - كشف التهنيج (stall) وإطلاق حدث buffering/bufferOk
   يعتمد على: Hls (hls.js) و mpegts (mpegts.js) المُحمّلين مسبقاً
   ══════════════════════════════════════════════════════════════ */

class PlayerEngine extends EventTarget {
  constructor(videoEl, opts = {}) {
    super();
    this.video = videoEl;
    this.proxyBase = opts.proxyBase || '';
    this.requestInterceptor = typeof opts.requestInterceptor === 'function' ? opts.requestInterceptor : null;

    this.qualitySources = [];      // [{label, url}, ...]
    this.currentQualityIdx = 0;
    this.qualityFallbackTried = new Set(); // فهارس الجودات التي جُرِّبت وفشلت بالمحاولة الحالية

    this.hls = null;               // نسخة hls.js الحالية
    this.mpegtsPlayer = null;      // نسخة mpegts.js الحالية
    this._usingNativeHls = false;  // تشغيل HLS أصلي (Safari) بدون hls.js

    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectTimer = null;

    this._stallTimer = null;
    this._stallThresholdMs = 8000;   // إذا استمر buffering أكثر من هذه المدة نعتبره تهنيج حقيقي
    this._isBuffering = false;

    this._loadToken = 0; // لمنع سباقات التحميل عند تبديل الجودة بسرعة

    this._bindVideoEvents();
  }

  /* ────────────── أدوات مساعدة ثابتة ────────────── */

  static isRawTs(url) {
    if (!url) return false;
    const clean = String(url).split('?')[0].split('#')[0];
    return /\.ts$/i.test(clean);
  }

  static isM3u8(url) {
    if (!url) return false;
    const clean = String(url).split('?')[0].split('#')[0];
    return /\.m3u8$/i.test(clean);
  }

  /* ────────────── ضبط مصادر الجودة ────────────── */

  setQualitySources(sources) {
    this.qualitySources = Array.isArray(sources) ? sources : [];
    this.currentQualityIdx = 0;
    this.qualityFallbackTried.clear();
  }

  /* ────────────── حل الرابط (بروكسي عند الحاجة) ────────────── */

  _resolveUrl(url) {
    if (!url) return url;
    const isHttp = /^http:\/\//i.test(url);
    const pageIsHttps = location.protocol === 'https:';
    // نمرر عبر البروكسي فقط إذا الرابط http والصفحة https (مشكلة mixed content)
    // أو إذا تم تفعيل البروكسي دائماً من الإعدادات
    if (this.proxyBase && isHttp && pageIsHttps) {
      const base = this.proxyBase.replace(/\/+$/, '');
      return `${base}/proxy?url=${encodeURIComponent(url)}`;
    }
    return url;
  }

  /* ────────────── إشعال حدث مساعد ────────────── */

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /* ────────────── تشغيل جودة معيّنة ────────────── */

  playQuality(idx) {
    if (idx < 0 || idx >= this.qualitySources.length) return;
    this.currentQualityIdx = idx;
    this._reconnectAttempts = 0;
    clearTimeout(this._reconnectTimer);
    this._teardownActivePlayers();

    const token = ++this._loadToken;
    const source = this.qualitySources[idx];
    this._emit('loading');
    this._loadSource(source, idx, token);
  }

  _loadSource(source, idx, token) {
    if (!source || !source.url) { this._emit('fatal', 'رابط البث غير صالح.'); return; }
    const resolvedUrl = this._resolveUrl(source.url);

    if (PlayerEngine.isRawTs(source.url)) {
      this._loadWithMpegts(resolvedUrl, idx, token);
    } else {
      this._loadWithHls(resolvedUrl, idx, token);
    }
  }

  /* ────────────── تشغيل HLS (m3u8) ────────────── */

  _loadWithHls(url, idx, token) {
    const video = this.video;

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        liveSyncDurationCount: 3,
        enableWorker: true,
        lowLatencyMode: false,
        xhrSetup: (xhr, xhrUrl) => {
          if (this.requestInterceptor) {
            try { this.requestInterceptor(xhr, xhrUrl); } catch (e) {}
          }
        }
      });
      this.hls = hls;
      this._usingNativeHls = false;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token !== this._loadToken) return;
        this._reconnectAttempts = 0;
        video.play().catch(() => {});
        this._emit('ready');
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
        if (token !== this._loadToken) return;
        const level = hls.levels && hls.levels[data.level];
        this._emit('levelSwitched', {
          label: this.qualitySources[idx]?.label || 'تلقائي',
          height: level?.height || null
        });
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (token !== this._loadToken) return;
        if (!data.fatal) return;

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            this._handleNetworkError(idx, token, () => hls.startLoad());
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            this._emit('recoveringMedia');
            try { hls.recoverMediaError(); } catch (e) { this._tryFallbackOrFatal(idx, token); }
            break;
          default:
            this._tryFallbackOrFatal(idx, token);
            break;
        }
      });

      hls.loadSource(url);
      hls.attachMedia(video);

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // دعم HLS أصلي (Safari / iOS)
      this._usingNativeHls = true;
      video.src = url;

      const onLoaded = () => {
        if (token !== this._loadToken) return;
        video.removeEventListener('loadedmetadata', onLoaded);
        video.play().catch(() => {});
        this._emit('ready');
      };
      video.addEventListener('loadedmetadata', onLoaded);

      const onError = () => {
        if (token !== this._loadToken) return;
        this._handleNetworkError(idx, token, () => {
          video.src = url;
          video.load();
          video.play().catch(() => {});
        });
      };
      video.addEventListener('error', onError, { once: true });

    } else {
      this._emit('fatal', 'المتصفح لا يدعم تشغيل HLS.');
    }
  }

  /* ────────────── تشغيل MPEG-TS خام ────────────── */

  _loadWithMpegts(url, idx, token) {
    const video = this.video;

    if (!window.mpegts || !mpegts.isSupported()) {
      this._emit('fatal', 'المتصفح لا يدعم تشغيل بث TS الخام.');
      return;
    }

    const player = mpegts.createPlayer({
      type: 'mpegts',
      isLive: true,
      url
    }, {
      enableWorker: true,
      liveBufferLatencyChasing: true,
      liveSync: true
    });

    this.mpegtsPlayer = player;
    this._usingNativeHls = false;

    player.on(mpegts.Events.ERROR, () => {
      if (token !== this._loadToken) return;
      this._handleNetworkError(idx, token, () => {
        try { player.unload(); player.load(); player.play(); } catch (e) {}
      });
    });

    player.on(mpegts.Events.LOADING_COMPLETE, () => {
      if (token !== this._loadToken) return;
      this._emit('levelSwitched', { label: this.qualitySources[idx]?.label || 'مباشر', height: null });
    });

    player.attachMediaElement(video);
    player.load();
    player.play().then(() => {
      if (token !== this._loadToken) return;
      this._emit('ready');
    }).catch(() => {
      if (token !== this._loadToken) return;
      this._emit('ready'); // بعض المتصفحات ترفض autoplay بالصوت، الواجهة تعالج الضغط اليدوي
    });
  }

  /* ────────────── معالجة أخطاء الشبكة (إعادة اتصال) ────────────── */

  _handleNetworkError(idx, token, resumeFn) {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._tryFallbackOrFatal(idx, token);
      return;
    }
    this._reconnectAttempts++;
    this._emit('reconnecting', this._reconnectAttempts);

    clearTimeout(this._reconnectTimer);
    const delay = Math.min(1000 * this._reconnectAttempts, 5000);
    this._reconnectTimer = setTimeout(() => {
      if (token !== this._loadToken) return;
      try { resumeFn(); } catch (e) { this._tryFallbackOrFatal(idx, token); }
    }, delay);
  }

  /* ────────────── الانتقال لجودة أخرى عند الفشل النهائي ────────────── */

  _tryFallbackOrFatal(idx, token) {
    this.qualityFallbackTried.add(idx);

    const nextIdx = this.qualitySources.findIndex((_, i) => !this.qualityFallbackTried.has(i));
    if (nextIdx !== -1) {
      this._emit('fallback', { label: this.qualitySources[nextIdx]?.label || '' });
      this._teardownActivePlayers();
      this.currentQualityIdx = nextIdx;
      this._reconnectAttempts = 0;
      const newToken = ++this._loadToken;
      this._loadSource(this.qualitySources[nextIdx], nextIdx, newToken);
    } else {
      this._emit('fatal', 'تعذّر تشغيل البث من جميع الروابط المتاحة.');
    }
  }

  /* ────────────── إيقاف/تفكيك المشغلات الحالية ────────────── */

  _teardownActivePlayers() {
    clearTimeout(this._stallTimer);
    this._stallTimer = null;

    if (this.hls) {
      try { this.hls.destroy(); } catch (e) {}
      this.hls = null;
    }
    if (this.mpegtsPlayer) {
      try {
        this.mpegtsPlayer.pause();
        this.mpegtsPlayer.unload();
        this.mpegtsPlayer.detachMediaElement();
        this.mpegtsPlayer.destroy();
      } catch (e) {}
      this.mpegtsPlayer = null;
    }
    try {
      this.video.removeAttribute('src');
      this.video.load();
    } catch (e) {}
    this._usingNativeHls = false;
  }

  /* ────────────── التحكم بالتشغيل ────────────── */

  togglePlay() {
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
  }

  setVolume(v) {
    this.video.volume = v;
    if (v > 0 && this.video.muted) this.video.muted = false;
  }

  /* ────────────── ربط أحداث عنصر الفيديو ────────────── */

  _bindVideoEvents() {
    const video = this.video;

    video.addEventListener('play',  () => this._emit('playStateChanged'));
    video.addEventListener('pause', () => this._emit('playStateChanged'));

    video.addEventListener('waiting', () => {
      this._isBuffering = true;
      this._emit('buffering');
      clearTimeout(this._stallTimer);
      this._stallTimer = setTimeout(() => {
        if (this._isBuffering) this._emit('stallDetected');
      }, this._stallThresholdMs);
    });

    video.addEventListener('playing', () => {
      this._isBuffering = false;
      clearTimeout(this._stallTimer);
      this._emit('bufferOk');
    });

    video.addEventListener('canplay', () => {
      if (this._isBuffering) {
        this._isBuffering = false;
        clearTimeout(this._stallTimer);
        this._emit('bufferOk');
      }
    });
  }
}
