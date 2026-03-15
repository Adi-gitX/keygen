import { useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY = 'keygen.doneLinks';
const PRESET_COUNTS = [10, 20, 50, 100];
const CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 16;
const MAX_CUSTOM_COUNT = 1000;
const TEST_CONCURRENCY = 6;

const STATUS_META = {
  untested: { label: 'Untested', detail: 'Ready to test', tone: 'muted' },
  testing: { label: 'Testing', detail: 'Checking now...', tone: 'dark' },
  working: { label: 'Working', detail: 'Verified in browser', tone: 'success' },
  'not-working': { label: 'Not working', detail: 'Request returned an error', tone: 'danger' },
  blocked: { label: 'Blocked', detail: 'Browser could not verify this URL', tone: 'warning' },
  invalid: { label: 'Invalid', detail: 'Use a full http(s) URL to test', tone: 'warning' },
};

function createCode() {
  let value = '';

  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const randomIndex = Math.floor(Math.random() * CHARACTERS.length);
    value += CHARACTERS[randomIndex];
  }

  return value;
}

function normalizeBase(input) {
  return input.endsWith('/') ? input : `${input}/`;
}

function readDoneLinks() {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const storedValue = window.localStorage.getItem(STORAGE_KEY);
    return storedValue ? JSON.parse(storedValue) : {};
  } catch (error) {
    return {};
  }
}

function buildCheckState(status, extra = {}) {
  return {
    status,
    label: STATUS_META[status].label,
    detail: STATUS_META[status].detail,
    checkedAt: null,
    ...extra,
  };
}

function isHttpUrl(value) {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

async function checkGeneratedLink(fullLink) {
  if (!isHttpUrl(fullLink)) {
    return buildCheckState('invalid');
  }

  try {
    const response = await fetch(fullLink, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
    });

    if (response.ok) {
      return buildCheckState('working', {
        detail: `HTTP ${response.status}`,
        checkedAt: Date.now(),
      });
    }

    return buildCheckState('not-working', {
      detail: `HTTP ${response.status}`,
      checkedAt: Date.now(),
    });
  } catch (error) {
    return buildCheckState('blocked', {
      detail: 'Could not verify in the browser. The site may block CORS or the request may have failed.',
      checkedAt: Date.now(),
    });
  }
}

function App() {
  const [baseInput, setBaseInput] = useState('');
  const [selectedCount, setSelectedCount] = useState(10);
  const [customCount, setCustomCount] = useState('');
  const [generatedLinks, setGeneratedLinks] = useState([]);
  const [doneLinks, setDoneLinks] = useState(() => readDoneLinks());
  const [linkChecks, setLinkChecks] = useState({});
  const [isTestingAll, setIsTestingAll] = useState(false);
  const latestRunRef = useRef(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doneLinks));
    } catch (error) {
      // Ignore storage issues so generation still works in restricted browsers.
    }
  }, [doneLinks]);

  const customError = useMemo(() => {
    if (selectedCount !== 'custom') {
      return '';
    }

    if (customCount.trim() === '') {
      return 'Enter a custom quantity to generate links.';
    }

    const numericValue = Number(customCount);

    if (!Number.isInteger(numericValue) || numericValue <= 0) {
      return 'Custom quantity must be a whole number greater than 0.';
    }

    if (numericValue > MAX_CUSTOM_COUNT) {
      return `Custom quantity cannot be more than ${MAX_CUSTOM_COUNT}.`;
    }

    return '';
  }, [customCount, selectedCount]);

  const resolvedCount = selectedCount === 'custom' ? Number(customCount) : selectedCount;
  const trimmedInput = baseInput.trim();
  const canGenerate = trimmedInput !== '' && customError === '';
  const doneCount = generatedLinks.filter((item) => Boolean(doneLinks[item.fullLink])).length;

  const testSummary = useMemo(() => {
    return generatedLinks.reduce(
      (summary, item) => {
        const status = linkChecks[item.fullLink]?.status ?? 'untested';
        summary.total += 1;
        summary[status] += 1;
        return summary;
      },
      {
        total: 0,
        untested: 0,
        testing: 0,
        working: 0,
        'not-working': 0,
        blocked: 0,
        invalid: 0,
      },
    );
  }, [generatedLinks, linkChecks]);

  function handleGenerate(event) {
    event.preventDefault();

    if (!canGenerate) {
      return;
    }

    latestRunRef.current += 1;

    const normalizedBase = normalizeBase(trimmedInput);
    const knownLinks = new Set();
    const nextLinks = [];

    while (nextLinks.length < resolvedCount) {
      const suffix = createCode();
      const fullLink = `${normalizedBase}${suffix}`;

      if (knownLinks.has(fullLink)) {
        continue;
      }

      knownLinks.add(fullLink);
      nextLinks.push({
        id: `${Date.now()}-${nextLinks.length}-${suffix}`,
        suffix,
        fullLink,
      });
    }

    setGeneratedLinks(nextLinks);
    setLinkChecks({});
    setIsTestingAll(false);
  }

  function handleLinkClick(fullLink) {
    setDoneLinks((currentValue) => ({
      ...currentValue,
      [fullLink]: true,
    }));
  }

  function clearResults() {
    latestRunRef.current += 1;
    setGeneratedLinks([]);
    setLinkChecks({});
    setIsTestingAll(false);
  }

  async function runCheckForLink(fullLink) {
    setLinkChecks((currentValue) => ({
      ...currentValue,
      [fullLink]: buildCheckState('testing'),
    }));

    const result = await checkGeneratedLink(fullLink);

    setLinkChecks((currentValue) => ({
      ...currentValue,
      [fullLink]: result,
    }));
  }

  async function handleTestSingle(fullLink) {
    await runCheckForLink(fullLink);
  }

  async function handleTestAll() {
    if (generatedLinks.length === 0 || isTestingAll) {
      return;
    }

    const runId = Date.now();
    latestRunRef.current = runId;
    setIsTestingAll(true);

    const queue = generatedLinks.map((item) => item.fullLink);
    const workerCount = Math.min(TEST_CONCURRENCY, queue.length);

    async function worker() {
      while (queue.length > 0) {
        const fullLink = queue.shift();

        if (!fullLink || latestRunRef.current !== runId) {
          return;
        }

        setLinkChecks((currentValue) => ({
          ...currentValue,
          [fullLink]: buildCheckState('testing'),
        }));

        const result = await checkGeneratedLink(fullLink);

        if (latestRunRef.current !== runId) {
          return;
        }

        setLinkChecks((currentValue) => ({
          ...currentValue,
          [fullLink]: result,
        }));
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (latestRunRef.current === runId) {
      setIsTestingAll(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Black / White / Minimal</p>
          <h1>Generate, review, and test every link in one place.</h1>
          <p className="hero-text">
            Create full links with 16-character keys, review them in a clean combinations box,
            and test them in a separate monitor to see which ones work and which ones do not.
          </p>
        </div>

        <form className="generator-panel" onSubmit={handleGenerate}>
          <label className="input-group" htmlFor="base-input">
            <span>Base link or text</span>
            <input
              id="base-input"
              name="base-input"
              type="text"
              placeholder="https://example.com/invite"
              value={baseInput}
              onChange={(event) => setBaseInput(event.target.value)}
            />
          </label>

          <div className="controls-row">
            <div className="chip-group" aria-label="Select quantity">
              {PRESET_COUNTS.map((count) => (
                <button
                  key={count}
                  className={selectedCount === count ? 'chip active' : 'chip'}
                  type="button"
                  onClick={() => setSelectedCount(count)}
                >
                  {count}
                </button>
              ))}
              <button
                className={selectedCount === 'custom' ? 'chip active' : 'chip'}
                type="button"
                onClick={() => setSelectedCount('custom')}
              >
                Custom
              </button>
            </div>

            {selectedCount === 'custom' ? (
              <label className="custom-input" htmlFor="custom-count">
                <span>Qty</span>
                <input
                  id="custom-count"
                  name="custom-count"
                  type="number"
                  min="1"
                  max={MAX_CUSTOM_COUNT}
                  step="1"
                  placeholder="250"
                  value={customCount}
                  onChange={(event) => setCustomCount(event.target.value)}
                />
              </label>
            ) : null}
          </div>

          {customError ? <p className="validation-message">{customError}</p> : null}

          <div className="actions-row">
            <button className="primary-button" type="submit" disabled={!canGenerate}>
              Generate combinations
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={clearResults}
              disabled={generatedLinks.length === 0}
            >
              Clear current list
            </button>
          </div>
        </form>
      </section>

      <section className="panel-grid">
        <section className="surface-panel" aria-live="polite">
          <header className="panel-header">
            <div>
              <p className="results-label">Box 1</p>
              <h2>Generated combinations</h2>
            </div>
            <div className="results-meta">
              <span>{generatedLinks.length} total</span>
              <span>{doneCount} done</span>
            </div>
          </header>

          {generatedLinks.length === 0 ? (
            <div className="empty-state compact-empty">
              <p>Generate a batch to see every full link and its current done state.</p>
            </div>
          ) : (
            <div className="compact-list">
              {generatedLinks.map((item, index) => {
                const isDone = Boolean(doneLinks[item.fullLink]);

                return (
                  <a
                    key={item.id}
                    className={isDone ? 'compact-row link-row done' : 'compact-row link-row'}
                    href={item.fullLink}
                    onClick={() => handleLinkClick(item.fullLink)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <div className="result-topline">
                      <span className="result-index">{String(index + 1).padStart(2, '0')}</span>
                      <span className="result-code">{item.suffix}</span>
                      <span className={isDone ? 'status-pill status-done' : 'status-pill status-open'}>
                        {isDone ? 'Done' : 'Open'}
                      </span>
                    </div>
                    <p className="result-link">{item.fullLink}</p>
                  </a>
                );
              })}
            </div>
          )}
        </section>

        <section className="surface-panel" aria-live="polite">
          <header className="panel-header">
            <div>
              <p className="results-label">Box 2</p>
              <h2>Test monitor</h2>
            </div>
            <button
              className="primary-button compact-button"
              type="button"
              onClick={handleTestAll}
              disabled={generatedLinks.length === 0 || isTestingAll}
            >
              {isTestingAll ? 'Testing all...' : 'Test all links'}
            </button>
          </header>

          <p className="panel-note">
            Browser testing works best for full `http` or `https` URLs. Some sites may show as
            blocked if they do not allow client-side requests.
          </p>

          <div className="summary-grid">
            <div className="summary-card">
              <span>Total</span>
              <strong>{testSummary.total}</strong>
            </div>
            <div className="summary-card">
              <span>Working</span>
              <strong>{testSummary.working}</strong>
            </div>
            <div className="summary-card">
              <span>Not working</span>
              <strong>{testSummary['not-working']}</strong>
            </div>
            <div className="summary-card">
              <span>Blocked</span>
              <strong>{testSummary.blocked + testSummary.invalid}</strong>
            </div>
          </div>

          {generatedLinks.length === 0 ? (
            <div className="empty-state compact-empty">
              <p>Testing will appear here once a set of links has been generated.</p>
            </div>
          ) : (
            <div className="compact-list">
              {generatedLinks.map((item, index) => {
                const currentCheck = linkChecks[item.fullLink] ?? buildCheckState('untested');
                const toneClass = `status-pill status-${STATUS_META[currentCheck.status].tone}`;

                return (
                  <div key={item.id} className="compact-row test-row">
                    <div className="result-topline">
                      <span className="result-index">{String(index + 1).padStart(2, '0')}</span>
                      <span className={toneClass}>{currentCheck.label}</span>
                      <button
                        className="mini-button"
                        type="button"
                        onClick={() => handleTestSingle(item.fullLink)}
                        disabled={currentCheck.status === 'testing' || isTestingAll}
                      >
                        {currentCheck.status === 'testing' ? 'Checking' : 'Test'}
                      </button>
                    </div>
                    <p className="result-link">{item.fullLink}</p>
                    <p className="test-detail">{currentCheck.detail}</p>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

export default App;
