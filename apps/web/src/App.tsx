import { Playground } from './Playground';

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Sim Studio</span>
        <nav>
          <span className="tab active">Playground</span>
          <span className="tab disabled" title="Phase 4">Review queue</span>
          <span className="tab disabled" title="Phase 5">Analytics</span>
        </nav>
      </header>
      <Playground />
    </div>
  );
}
