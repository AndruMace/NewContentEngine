import { useEffect, useState } from 'react';
import { Playground } from './Playground';
import { ReviewPage } from './ReviewPage';
import { AnalyticsPage } from './AnalyticsPage';
import { UploadPage } from './UploadPage';

type Route = 'playground' | 'review' | 'upload' | 'analytics';
const routeFromHash = (): Route =>
  location.hash.startsWith('#/review/upload/')
    ? 'upload'
    : location.hash.startsWith('#/review')
      ? 'review'
      : location.hash.startsWith('#/analytics')
        ? 'analytics'
        : 'playground';
const uploadId = () => location.hash.slice('#/review/upload/'.length);

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [id, setId] = useState(uploadId);
  useEffect(() => {
    const onHash = () => {
      setRoute(routeFromHash());
      setId(uploadId());
    };
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
          <a className={`tab${route === 'review' || route === 'upload' ? ' active' : ''}`} href="#/review">
            Batches &amp; Review
          </a>
          <a className={`tab${route === 'analytics' ? ' active' : ''}`} href="#/analytics">
            Analytics
          </a>
        </nav>
      </header>
      {route === 'playground' ? <Playground /> : route === 'review' ? <ReviewPage /> : route === 'upload' ? <UploadPage id={id} /> : <AnalyticsPage />}
    </div>
  );
}
