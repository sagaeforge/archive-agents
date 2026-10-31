import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { start } from './bench.js';
function App() {
  const host = useRef(null); const [status, setStatus] = useState('init');
  useEffect(() => { start(host.current, setStatus); }, []);
  return (<div style={{ position: 'relative', width: '100%', height: '100%' }}>
    <div ref={host} id="stage" style={{ position: 'absolute', inset: 0 }} />
    <div id="status" style={{ position: 'absolute', left: 4, top: 4, font: '11px monospace', color: '#888', pointerEvents: 'none', zIndex: 9 }}>{status}</div>
  </div>);
}
createRoot(document.getElementById('root')).render(<App />);
