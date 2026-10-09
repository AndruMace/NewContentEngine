import { useEffect, useState } from 'react';
import { Playground } from './Playground';
import { ReviewPage } from './ReviewPage';
import { AnalyticsPage } from './AnalyticsPage';

type Route = 'playground' | 'review' | 'analytics';
const routeFromHash = (): Route => (location.hash.startsWith('#/review') ? 'review' : location.hash.startsWith('#/analytics') ? 'analytics' : 'playground');

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
          <a className={`tab${route === 'analytics' ? ' active' : ''}`} href="#/analytics">
            Analytics
          </a>
        </nav>
      </header>
      {route === 'playground' ? <Playground /> : route === 'review' ? <ReviewPage /> : <AnalyticsPage />}
    </div>
  );
}
