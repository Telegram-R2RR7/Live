/* ══════════════════════════════════════════════════════════════
   PlayerEngine v2 — مع Watchdog حقيقي لمنع التعليق اللانهائي
   ══════════════════════════════════════════════════════════════ */

class PlayerEngine extends EventTarget {
  constructor(videoEl, opts = {}) {
    super();
    this.video = videoEl;
    this.proxyBase = opts.proxyBase || '';
    this.requestInterceptor = typeof opts.requestInterceptor === 'function' ? opts.requestInterceptor : null;

    // كم مللي ثانية ننتظر قبل ما نعتبر "لا يوجد رد = فشل" (بدل التعليق اللانهائي)
    this.connectTimeoutMs = opts.connectTimeoutMs || 12000;
    // إذا صار buffering/تهنيج ومستمر أكثر من هالمدة، نعيد تحميل المصدر بالكامل
    this.stallRecoveryMs = opts.stallRecoveryMs || 14000;
    // هل نجبر كل روابط TS الخام تمر عبر البروكسي دائماً (TS غالباً بدون CORS)
    this.forceProxyForTs = opts.forceProxyForTs !== false; // true افتراضياً

    this.qualitySources = [];
    this.currentQualityIdx = 0;
    this.qualityFallbackTried = new Set();

    this.hls = null;
    this.mpegtsPlayer = null;
    this._usingNativeHls = false;

    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectTimer = null;

    this._connectWatchdog = null;
    this._stallTimer = null;
    this._stallRecoveryTimer = null;
    this._stallThresholdMs = 8000;
    this._isBuffering = false;

    this._loadToken = 0;

    this._bindVideoEvents();
  }

  /* ────────────── أدوات ثابتة ────────────── */

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

  /* ────────────── مصادر الجودة ────────────── */

  setQualitySources(sources) {
    this.qualitySources = Array.isArray(sources) ? sources : [];
    this.currentQualityIdx = 0;
    this.qualityFallbackTried.clear();
  }

  /* ────────────── حل الرابط عبر البروكسي عند الحاجة ────────────── */

  _resolveUrl(url, isTs) {
    if (!url) return url;
    const isHttp = /^http:\/\//i.test(url);
    const pageIsHttps = location.protocol === 'https:';
    const mixedContent = isHttp && pageIsHttps;

    // TS الخام غالباً بدون CORS headers، فنمرره دائماً عبر البروكسي إذا مفعّل
    // أو إذا في مشكلة mixed content لأي نوع رابط
    const shouldProxy = this.proxyBase && (mixedContent || (isTs && this.forceProxyForTs));

    if (shouldProxy) {
      const base = this.proxyBase.replace(/\/+$/, '');
      return `${base}/proxy?url=${encodeURIComponent(url)}`;
    }
    return url;
  }

  /* ────────────── إشعال حدث ────────────── */

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /* ────────────── Watchdog: يمنع التعليق اللانهائي ────────────── */

  _armConnectWatchdog(idx, token) {
    this._clearConnectWatchdog();
    this._connectWatchdog = setTimeout(() => {
      if (token !== this._loadToken) return;
      // ما وصل أي رد خلال المدة المحددة → نعامله كفشل شبكة صريح
      this._handleNetworkError(idx, token, () => {
        // إعادة تحميل نفس المصدر من الصفر
        this._teardownActivePlayers();
        this._loadSource(this.qualitySources[idx], idx, token);
      });
    }, this.connectTimeoutMs);
  }
  _clearConnectWatchdog() {
    clearTimeout(this._connectWatchdog);
    this._connectWatchdog = null;
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
    this._armConnectWatchdog(idx, token);
    this._loadSource(source, idx, token);
  }

  _loadSource(source, idx, token) {
    if (!source || !source.url) { this._clearConnectWatchdog(); this._emit('fatal', 'رابط البث غير صالح.'); return; }
    const isTs = PlayerEngine.isRawTs(source.url);
    const resolvedUrl = this._resolveUrl(source.url, isTs);

    if (isTs) {
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
        manifestLoadingTimeOut: 9000,
        manifestLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 1000,
        levelLoadingTimeOut: 9000,
        fragLoadingTimeOut: 15000,
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
        this._clearConnectWatchdog();
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
      this._usingNativeHls = true;
      video.src = url;

      const onLoaded = () => {
        if (token !== this._loadToken) return;
        video.removeEventListener('loadedmetadata', onLoaded);
        this._clearConnectWatchdog();
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
      this._clearConnectWatchdog();
      this._emit('fatal', 'المتصفح لا يدعم تشغيل HLS.');
    }
  }

  /* ────────────── تشغيل MPEG-TS خام ────────────── */

  _loadWithMpegts(url, idx, token) {
    const video = this.video;

    if (!window.mpegts || !mpegts.isSupported()) {
      this._clearConnectWatchdog();
      this._emit('fatal', 'المتصفح لا يدعم تشغيل بث TS الخام.');
      return;
    }

    const player = mpegts.createPlayer({
      type: 'mpegts',
      isLive: true,
      url
    }, {
      enableWorker: true,
      enableStashBuffer: false,     // يقلل زمن الوصول الأول ويمنع تراكم بافر يسبب إحساس بالتعليق
      liveBufferLatencyChasing: true,
      liveSync: true,
      liveSyncMaxLatency: 3,
      liveSyncTargetLatency: 1.0,
      autoCleanupSourceBuffer: true
    });

    this.mpegtsPlayer = player;
    this._usingNativeHls = false;

    let gotFirstData = false;

    player.on(mpegts.Events.ERROR, () => {
      if (token !== this._loadToken) return;
      this._handleNetworkError(idx, token, () => {
        try { player.unload(); player.load(); player.play(); } catch (e) {}
      });
    });

    player.on(mpegts.Events.MEDIA_INFO, () => {
      if (token !== this._loadToken) return;
      gotFirstData = true;
      this._clearConnectWatchdog();
      this._emit('levelSwitched', { label: this.qualitySources[idx]?.label || 'مباشر', height: null });
    });

    player.attachMediaElement(video);
    player.load();
    player.play().then(() => {
      if (token !== this._loadToken) return;
      if (gotFirstData) this._clearConnectWatchdog();
      this._emit('ready');
    }).catch(() => {
      if (token !== this._loadToken) return;
      this._emit('ready'); // بعض المتصفحات تمنع autoplay بالصوت، المستخدم يضغط تشغيل يدوياً
    });
  }

  /* ────────────── معالجة أخطاء الشبكة (إعادة اتصال) ────────────── */

  _handleNetworkError(idx, token, resumeFn) {
    this._clearConnectWatchdog();
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
      this._armConnectWatchdog(idx, token); // نعيد تسليح الـ watchdog للمحاولة الجديدة
      try { resumeFn(); } catch (e) { this._tryFallbackOrFatal(idx, token); }
    }, delay);
  }

  /* ────────────── الانتقال لجودة أخرى عند الفشل النهائي ────────────── */

  _tryFallbackOrFatal(idx, token) {
    this._clearConnectWatchdog();
    this.qualityFallbackTried.add(idx);

    const nextIdx = this.qualitySources.findIndex((_, i) => !this.qualityFallbackTried.has(i));
    if (nextIdx !== -1) {
      this._emit('fallback', { label: this.qualitySources[nextIdx]?.label || '' });
      this._teardownActivePlayers();
      this.currentQualityIdx = nextIdx;
      this._reconnectAttempts = 0;
      const newToken = ++this._loadToken;
      this._armConnectWatchdog(nextIdx, newToken);
      this._loadSource(this.qualitySources[nextIdx], nextIdx, newToken);
    } else {
      this._emit('fatal', 'تعذّر تشغيل البث من جميع الروابط المتاحة.');
    }
  }

  /* ────────────── إيقاف/تفكيك المشغلات الحالية ────────────── */

  _teardownActivePlayers() {
    this._clearConnectWatchdog();
    clearTimeout(this._stallTimer);
    clearTimeout(this._stallRecoveryTimer);
    this._stallTimer = null;
    this._stallRecoveryTimer = null;

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

  /* ────────────── ربط أحداث عنصر الفيديو + استرجاع من التهنيج ────────────── */

  _bindVideoEvents() {
    const video = this.video;

    video.addEventListener('play',  () => this._emit('playStateChanged'));
    video.addEventListener('pause', () => this._emit('playStateChanged'));

    video.addEventListener('waiting', () => {
      this._isBuffering = true;
      this._emit('buffering');
      clearTimeout(this._stallTimer);
      this._stallTimer = setTimeout(() => {
        if (this._isBuffering) {
          this._emit('stallDetected');
          this._armStallRecovery();
        }
      }, this._stallThresholdMs);
    });

    video.addEventListener('playing', () => {
      this._isBuffering = false;
      clearTimeout(this._stallTimer);
      clearTimeout(this._stallRecoveryTimer);
      this._emit('bufferOk');
    });

    video.addEventListener('canplay', () => {
      if (this._isBuffering) {
        this._isBuffering = false;
        clearTimeout(this._stallTimer);
        clearTimeout(this._stallRecoveryTimer);
        this._emit('bufferOk');
      }
    });
  }

  // إذا التهنيج استمر لمدة طويلة جداً، نعتبره تعليق حقيقي ونعيد تحميل المصدر كاملاً
  _armStallRecovery() {
    clearTimeout(this._stallRecoveryTimer);
    const idx = this.currentQualityIdx;
    const token = this._loadToken;
    this._stallRecoveryTimer = setTimeout(() => {
      if (!this._isBuffering || token !== this._loadToken) return;
      this._handleNetworkError(idx, token, () => {
        this._teardownActivePlayers();
        const newToken = ++this._loadToken;
        this._armConnectWatchdog(idx, newToken);
        this._loadSource(this.qualitySources[idx], idx, newToken);
      });
    }, this.stallRecoveryMs);
  }
}
