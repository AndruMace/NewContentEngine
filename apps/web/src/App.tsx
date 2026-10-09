import { useEffect, useState } from 'react';
import { Playground } from './Playground';
import { ReviewPage } from './ReviewPage';

type Route = 'playground' | 'review';
const routeFromHash = (): Route => (location.hash === '#/review' ? 'review' : 'playground');

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Sim Studio</span>
        <nav>
          <a className={`tab${route === 'playground' ? ' active' : ''}`} href="#/">
            Playground
          </a>
          <a className={`tab${route === 'review' ? ' active' : ''}`} href="#/review">
            Batches &amp; Review
          </a>
          <span className="tab disabled" title="Phase 5">
            Analytics
          </span>
        </nav>
      </header>
      {route === 'playground' ? <Playground /> : <ReviewPage />}
    </div>
  );
}
