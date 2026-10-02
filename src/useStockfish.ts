import { useState, useEffect, useRef, useCallback } from 'react';
// @ts-ignore
import stockfishJsSource from 'stockfish.js/stockfish.js?raw';

let cachedWorkerUrl: string | null = null;
function getStockfishWorkerUrl(): string | null {
  if (cachedWorkerUrl) return cachedWorkerUrl;
  try {
    const blob = new Blob([stockfishJsSource], { type: 'application/javascript' });
    cachedWorkerUrl = URL.createObjectURL(blob);
    return cachedWorkerUrl;
  } catch (e) {
    console.warn('Could not create Blob for Stockfish:', e);
    return null;
  }
}

export function useStockfish() {
  const workerRef = useRef<Worker | null>(null);
  const turnRef = useRef<'w' | 'b'>('w');
  const [evaluation, setEvaluation] = useState<number>(0);
  const [mate, setMate] = useState<number | null>(null);
  const [bestMove, setBestMove] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    let worker: Worker | null = null;
    try {
      const workerUrl = getStockfishWorkerUrl();
      if (workerUrl) {
        worker = new Worker(workerUrl);
        workerRef.current = worker;

        worker.onmessage = (e) => {
          const line = typeof e.data === 'string' ? e.data : '';
          
          if (line.includes('info depth') && line.includes('score')) {
            const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
            if (scoreMatch) {
              const type = scoreMatch[1];
              let val = parseInt(scoreMatch[2], 10);
              
              // Make score relative to White
              if (turnRef.current === 'b') {
                val = -val;
              }

              if (type === 'cp') {
                setEvaluation(val / 100);
                setMate(null);
              } else {
                setMate(val);
              }
            }
            
            const pvMatch = line.match(/pv (\w+)/);
            if (pvMatch) {
              setBestMove(pvMatch[1]);
            }
          } else if (line.startsWith('bestmove')) {
            const match = line.match(/^bestmove (\w+)/);
            if (match && match[1] !== '(none)') {
              setBestMove(match[1]);
            }
            setIsAnalyzing(false);
          }
        };

        worker.postMessage('uci');
        worker.postMessage('setoption name Threads value 1');
        worker.postMessage('isready');
      }
    } catch (err) {
      console.warn('Failed to initialize local Stockfish worker:', err);
    }

    return () => {
      if (worker) {
        try {
          worker.postMessage('quit');
          worker.terminate();
        } catch (e) {
          // ignore
        }
      }
      workerRef.current = null;
    };
  }, []);

  const analyze = useCallback((fen: string, colorToMove: 'w' | 'b') => {
    turnRef.current = colorToMove;
    if (workerRef.current) {
      workerRef.current.postMessage('stop');
      workerRef.current.postMessage(`position fen ${fen}`);
      workerRef.current.postMessage('go depth 14');
      setIsAnalyzing(true);
    }
  }, []);

  const stop = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage('stop');
    }
    setIsAnalyzing(false);
  }, []);

  return { evaluation, mate, bestMove, isAnalyzing, analyze, stop };
}
