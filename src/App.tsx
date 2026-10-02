import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Chess, Move, Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { ErrorBoundary } from "./ErrorBoundary";
import { QRCodeSVG } from "qrcode.react";
import { Scanner } from "@yudiel/react-qr-scanner";
import {
  Copy,
  ScanQrCode,
  Swords,
  QrCode,
  ChevronLeft,
  X,
  Bot,
  Users,
  MonitorPlay,
  Play,
  Palette,
  Activity,
  Download
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Game as EngineGame } from "js-chess-engine";
import { useStockfish } from "./useStockfish";
import { EvaluationBar } from "./EvaluationBar";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type ConnectionState =
  | "disconnected"
  | "hosting"
  | "waiting_for_answer"
  | "joining"
  | "connected";

type GameMode = "menu" | "p2p" | "local_pvp" | "local_pvc";

const WEB_RTC_CONFIG = {
  iceServers: [],
};

function encodeCode(desc: RTCSessionDescription | null) {
  if (!desc) return "";
  const compressed = JSON.stringify(desc);
  return btoa(compressed);
}

function decodeCode(code: string): RTCSessionDescriptionInit | null {
  try {
    return JSON.parse(atob(code));
  } catch (e) {
    return null;
  }
}

const ELO_LEVELS = [
  { level: 0, label: "Beginner (500 Elo)" },
  { level: 1, label: "Novice (1000 Elo)" },
  { level: 2, label: "Intermediate (1500 Elo)" },
  { level: 3, label: "Advanced (2000 Elo)" },
  { level: 4, label: "Master (2500 Elo)" },
];

const BOARD_PRESETS = [
  { id: "default", name: "Default", light: "#27272a", dark: "#18181b" },
  { id: "chess_com", name: "Chess.com", light: "#ebecd0", dark: "#739552" },
  { id: "lichess", name: "Lichess", light: "#dee3e6", dark: "#8ca2ad" },
  { id: "wood", name: "Wood", light: "#f0d9b5", dark: "#b58863" },
  { id: "coral", name: "Coral", light: "#b1e4b9", dark: "#70a2a3" },
];

export default function App() {
  const [boardPreset, setBoardPreset] = useState(BOARD_PRESETS[0]);
  const [showSettings, setShowSettings] = useState(false);
  const [game, setGame] = useState(new Chess());
  const [fen, setFen] = useState(game.fen());
  const [playerColor, setPlayerColor] = useState<"w" | "b">("w");
  const [gameMode, setGameMode] = useState<GameMode>("menu");
  
  // PVC specific states
  const [isPvcSetup, setIsPvcSetup] = useState(true);
  const [computerEloLevel, setComputerEloLevel] = useState<number>(1);
  const [playerUsername, setPlayerUsername] = useState("Player 1");
  const [computerUsername, setComputerUsername] = useState("Computer");

  const [connState, setConnState] = useState<ConnectionState>("disconnected");
  const [statusMessage, setStatusMessage] = useState("");

  const [localCode, setLocalCode] = useState("");
  const [remoteCodeInput, setRemoteCodeInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  // Click-to-move state
  const [moveFrom, setMoveFrom] = useState<Square | null>(null);
  const [optionSquares, setOptionSquares] = useState({});

  const [showAnalyzer, setShowAnalyzer] = useState(false);
  const { evaluation, mate, bestMove, isAnalyzing, analyze, stop: stopStockfish } = useStockfish();
  const [downloading, setDownloading] = useState(false);

  const handleDownloadStandaloneHtml = async () => {
    setDownloading(true);
    try {
      const response = await fetch('/download/chess-game.html');
      if (response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'chess-offline.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setDownloading(false);
        return;
      }
    } catch (e) {
      // ignore
    }

    try {
      const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'chess-offline.html';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export HTML:', err);
    }
    setDownloading(false);
  };

  useEffect(() => {
    if (showAnalyzer && gameMode !== "menu" && !game.isGameOver()) {
      analyze(fen, game.turn());
    } else {
      stopStockfish();
    }
  }, [fen, showAnalyzer, gameMode, game, analyze, stopStockfish]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);

  // Initialize DataChannel
  const setupDataChannel = (channel: RTCDataChannel) => {
    dcRef.current = channel;
    channel.onopen = () => {
      setConnState("connected");
      setStatusMessage("Connected! You can now play.");
    };
    channel.onclose = () => {
      setConnState("disconnected");
      setStatusMessage("Connection closed. The other player left.");
      cleanUpRtc();
    };
    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "MOVE") {
          const move = data.move;
          setGame((prevGame) => {
            const gameCopy = new Chess(prevGame.fen());
            gameCopy.move(move);
            setFen(gameCopy.fen());
            return gameCopy;
          });
          setMoveFrom(null);
          setOptionSquares({});
        } else if (data.type === "NEW_GAME") {
          setGame((prev) => {
            const copy = new Chess();
            setFen(copy.fen());
            return copy;
          });
          setMoveFrom(null);
          setOptionSquares({});
          setStatusMessage("Opponent started a new game.");
        }
      } catch (e) {
        console.warn("Failed to parse message", e);
      }
    };
  };

  const cleanUpRtc = () => {
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    setLocalCode("");
    setRemoteCodeInput("");
  };

  const initHost = async () => {
    cleanUpRtc();
    setIsGenerating(true);
    setConnState("hosting");
    setPlayerColor("w");
    setGame(new Chess());
    setFen(new Chess().fen());

    const pc = new RTCPeerConnection(WEB_RTC_CONFIG);
    pcRef.current = pc;

    const channel = pc.createDataChannel("chess");
    setupDataChannel(channel);

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        setLocalCode(encodeCode(pc.localDescription));
        setIsGenerating(false);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Timeout fallback for gathering
    setTimeout(() => {
      if (pc.iceGatheringState !== "complete" && pc.localDescription) {
        setLocalCode(encodeCode(pc.localDescription));
        setIsGenerating(false);
      }
    }, 3000);
  };

  const initJoin = () => {
    cleanUpRtc();
    setConnState("joining");
    setPlayerColor("b");
    setGame(new Chess());
    setFen(new Chess().fen());
  };

  const generateAnswerCode = async (offerString: string) => {
    const offer = decodeCode(offerString);
    if (!offer) {
      alert("Invalid offer code");
      return;
    }

    setIsGenerating(true);
    const pc = new RTCPeerConnection(WEB_RTC_CONFIG);
    pcRef.current = pc;

    pc.ondatachannel = (event) => {
      setupDataChannel(event.channel);
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        setLocalCode(encodeCode(pc.localDescription));
        setIsGenerating(false);
      }
    };

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Timeout fallback
    setTimeout(() => {
      if (pc.iceGatheringState !== "complete" && pc.localDescription) {
        setLocalCode(encodeCode(pc.localDescription));
        setIsGenerating(false);
      }
    }, 3000);
  };

  const acceptAnswerCode = async (answerString: string) => {
    const answer = decodeCode(answerString);
    if (!answer || !pcRef.current) {
      alert("Invalid answer code or no active session.");
      return;
    }
    await pcRef.current.setRemoteDescription(answer);
  };

  const makeComputerMove = useCallback(() => {
    if (game.isGameOver()) return;
    
    setTimeout(() => {
      try {
        const engine = new EngineGame(game.fen());
        const moveObj = engine.aiMove(computerEloLevel);
        const from = Object.keys(moveObj)[0].toLowerCase();
        const to = String(Object.values(moveObj)[0]).toLowerCase();

        setGame((prev) => {
          const copy = new Chess(prev.fen());
          copy.move({ from, to, promotion: 'q' });
          setFen(copy.fen());
          setMoveFrom(null);
          setOptionSquares({});
          return copy;
        });
      } catch (e) {
        // AI move was invalid or engine failed. Silently ignore or use console.warn.
        console.warn("AI Warning:", e);
      }
    }, 600);
  }, [game, computerEloLevel]);

  useEffect(() => {
    if (gameMode === "local_pvc" && !isPvcSetup && game.turn() !== playerColor[0] && !game.isGameOver()) {
      makeComputerMove();
    }
  }, [game, gameMode, isPvcSetup, playerColor, makeComputerMove]);

  const handleDrop = useCallback(({ sourceSquare, targetSquare, piece }: { sourceSquare: string; targetSquare: string; piece: string }) => {
    setMoveFrom(null);
    setOptionSquares({});
    if (gameMode === "menu" || (gameMode === "local_pvc" && isPvcSetup)) {
      return false;
    }
    if (game.isGameOver() || !sourceSquare || !targetSquare) {
      return false;
    }

    if (gameMode === "p2p" && connState !== "connected") {
      setStatusMessage("You must connect to an opponent first!");
      return false;
    }

    if (gameMode === "p2p" || gameMode === "local_pvc") {
        if (game.turn() !== playerColor[0]) {
            return false;
        }
    }

    try {
      const moveResult = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });

      if (moveResult) {
        setFen(game.fen());
        setGame(new Chess(game.fen()));
        if (gameMode === "p2p" && dcRef.current?.readyState === "open") {
          dcRef.current.send(JSON.stringify({ type: "MOVE", move: moveResult }));
        }
        return true;
      }
    } catch (e) {
        // Invalid move throws in chess.js 1.0.0-beta.8
        return false;
    }
    return false;
  }, [game, gameMode, isPvcSetup, playerColor, connState]);

  const getMoveOptions = useCallback((square: Square) => {
    const moves = game.moves({
      square,
      verbose: true,
    }) as Move[];
    if (moves.length === 0) {
      setOptionSquares({});
      return false;
    }

    const newSquares: any = {};
    moves.map((move) => {
      newSquares[move.to] = {
        background:
          game.get(move.to as Square) && game.get(move.to as Square)?.color !== game.get(square)?.color
            ? "radial-gradient(circle, transparent 75%, rgba(0,0,0,.25) 75%, rgba(0,0,0,.25) 85%, transparent 85%)"
            : "radial-gradient(circle, rgba(0,0,0,.15) 20%, transparent 20%)",
        borderRadius: "50%",
      };
      return move;
    });
    newSquares[square] = {
      background: "rgba(255, 255, 0, 0.4)",
    };
    setOptionSquares(newSquares);
    return true;
  }, [game]);

  const handleSquareClick = useCallback((args: any) => {
    const square = typeof args === 'object' && args !== null ? args.square : args;
    const sq = square as Square;
    if (gameMode === "menu" || (gameMode === "local_pvc" && isPvcSetup) || game.isGameOver()) {
      return;
    }

    if (gameMode === "p2p" && connState !== "connected") {
      setStatusMessage("You must connect to an opponent first!");
      return;
    }

    if (gameMode === "p2p" || gameMode === "local_pvc") {
        if (game.turn() !== playerColor[0]) {
            return;
        }
    }

    function resetFirstMove(sqs: Square) {
      if (game.get(sqs) && game.get(sqs)?.color === game.turn()) {
        const hasOptions = getMoveOptions(sqs);
        if (hasOptions) setMoveFrom(sqs);
        else {
          setMoveFrom(null);
          setOptionSquares({});
        }
      } else {
        setMoveFrom(null);
        setOptionSquares({});
      }
    }

    if (!moveFrom) {
      resetFirstMove(sq);
      return;
    }

    try {
      const moveResult = game.move({
        from: moveFrom,
        to: sq,
        promotion: "q",
      });

      if (moveResult) {
        setFen(game.fen());
        setGame(new Chess(game.fen()));
        setMoveFrom(null);
        setOptionSquares({});
        if (gameMode === "p2p" && dcRef.current?.readyState === "open") {
          dcRef.current.send(JSON.stringify({ type: "MOVE", move: moveResult }));
        }
      } else {
        resetFirstMove(sq);
      }
    } catch (e) {
      resetFirstMove(sq);
    }
  }, [game, gameMode, isPvcSetup, playerColor, connState, moveFrom, getMoveOptions]);

  const onPieceClick = useCallback(({ square }: { square: string | null }) => {
    if (square) handleSquareClick({ square });
  }, [handleSquareClick]);

  const startNewGame = () => {
    const newG = new Chess();
    setGame(newG);
    setFen(newG.fen());
    setMoveFrom(null);
    setOptionSquares({});
    if (gameMode === "p2p" && dcRef.current?.readyState === "open") {
      dcRef.current.send(JSON.stringify({ type: "NEW_GAME" }));
    }
  };

  const exitToMenu = () => {
    cleanUpRtc();
    setGameMode("menu");
    setConnState("disconnected");
    setGame(new Chess());
    setFen(new Chess().fen());
    setMoveFrom(null);
    setOptionSquares({});
  };

  const startPvcGame = () => {
    setIsPvcSetup(false);
    setGame(new Chess());
    setFen(new Chess().fen());
    setMoveFrom(null);
    setOptionSquares({});
  };

  const renderSidebarPanel = () => {
    if (gameMode === "menu") {
      return (
        <div className="flex flex-col w-full h-full justify-center">
          <div className="text-center space-y-2 mb-8">
            <Swords className="mx-auto w-12 h-12 text-[#52525b]" />
            <h1 className="text-[14px] font-bold tracking-[2px] uppercase text-[#e4e4e7]">Chess Applet</h1>
            <p className="text-[#a1a1aa] text-[12px] mt-2 mb-6">Select a game mode to play.</p>
          </div>

          <div className="flex flex-col gap-3">
            <button
              onClick={() => {
                 setGameMode("local_pvp");
                 setGame(new Chess());
                 setFen(new Chess().fen());
              }}
              className="w-full flex items-center justify-center gap-2 bg-[#27272a] hover:bg-[#3f3f46] text-[#e4e4e7] border border-[#27272a] p-3 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition"
            >
              <Users className="w-4 h-4" />
              Local PvP
            </button>

            <button
              onClick={() => {
                 setGameMode("local_pvc");
                 setIsPvcSetup(true);
              }}
              className="w-full flex items-center justify-center gap-2 bg-[#27272a] hover:bg-[#3f3f46] text-[#e4e4e7] border border-[#27272a] p-3 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition"
            >
              <Bot className="w-4 h-4" />
              Vs Computer
            </button>

            <button
              onClick={() => setGameMode("p2p")}
              className="w-full flex items-center justify-center gap-2 bg-[#e4e4e7] hover:bg-[#d4d4d8] text-[#09090b] p-3 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition"
            >
              <MonitorPlay className="w-4 h-4" />
              P2P Multiplayer
            </button>
          </div>

          <div className="mt-8 pt-6 border-t border-[#27272a] text-center">
            <p className="text-[10px] uppercase font-bold tracking-[1px] text-[#71717a] mb-1.5">Offline Standalone</p>
            <p className="text-[11px] text-[#a1a1aa] mb-3 leading-relaxed">Runs 100% locally with embedded Stockfish & PvC AI. No internet needed.</p>
            <button
              onClick={handleDownloadStandaloneHtml}
              disabled={downloading}
              className="w-full flex items-center justify-center gap-2 bg-[#18181b] hover:bg-[#27272a] border border-[#3f3f46] text-[#e4e4e7] p-2.5 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              {downloading ? 'Preparing HTML...' : 'Download Single HTML'}
            </button>
          </div>
        </div>
      );
    }

    if (gameMode === "local_pvc" && isPvcSetup) {
      return (
        <div className="flex flex-col w-full h-full justify-center">
          <button onClick={exitToMenu} className="self-start flex items-center tracking-[1px] text-[10px] uppercase text-[#71717a] hover:text-[#a1a1aa] font-bold mb-6">
             <ChevronLeft className="w-3 h-3 mr-1" /> Back
          </button>
          
          <div className="text-center space-y-2 mb-6">
            <Bot className="mx-auto w-10 h-10 text-[#52525b]" />
            <h1 className="text-[12px] font-bold tracking-[2px] uppercase text-[#e4e4e7]">Play vs Computer</h1>
          </div>

          <div className="flex flex-col gap-4 mb-6">
            <div>
              <label className="block text-[10px] uppercase font-bold tracking-[1px] text-[#71717a] mb-1.5">Your Username</label>
              <input 
                value={playerUsername}
                onChange={(e) => setPlayerUsername(e.target.value)}
                className="w-full bg-[#0a0a0b] border border-[#27272a] p-2 text-[11px] text-[#e4e4e7] rounded-sm placeholder-[#52525b]"
              />
            </div>
            
            <div>
              <label className="block text-[10px] uppercase font-bold tracking-[1px] text-[#71717a] mb-1.5">Computer Username</label>
              <input 
                value={computerUsername}
                onChange={(e) => setComputerUsername(e.target.value)}
                className="w-full bg-[#0a0a0b] border border-[#27272a] p-2 text-[11px] text-[#e4e4e7] rounded-sm placeholder-[#52525b]"
              />
            </div>

            <div>
               <label className="block text-[10px] uppercase font-bold tracking-[1px] text-[#71717a] mb-1.5">Computer Difficulty</label>
               <select 
                 value={computerEloLevel}
                 onChange={(e) => setComputerEloLevel(parseInt(e.target.value))}
                 className="w-full bg-[#0a0a0b] border border-[#27272a] p-2.5 text-[11px] text-[#e4e4e7] rounded-sm outline-none"
               >
                  {ELO_LEVELS.map(l => (
                    <option key={l.level} value={l.level}>{l.label}</option>
                  ))}
               </select>
            </div>

            <div>
               <label className="block text-[10px] uppercase font-bold tracking-[1px] text-[#71717a] mb-1.5">Play As</label>
               <div className="flex gap-2">
                 <button 
                   onClick={() => setPlayerColor('w')}
                   className={cn("flex-1 p-2 rounded-sm text-[11px] font-bold uppercase tracking-[1px] transition border", playerColor === 'w' ? 'bg-[#e4e4e7] text-[#09090b] border-[#e4e4e7]' : 'bg-[#18181b] text-[#71717a] border-[#27272a] hover:bg-[#27272a]')}
                 >
                   White
                 </button>
                 <button 
                   onClick={() => setPlayerColor('b')}
                   className={cn("flex-1 p-2 rounded-sm text-[11px] font-bold uppercase tracking-[1px] transition border", playerColor === 'b' ? 'bg-[#27272a] text-[#e4e4e7] border-[#3f3f46]' : 'bg-[#18181b] text-[#71717a] border-[#27272a] hover:bg-[#27272a]')}
                 >
                   Black
                 </button>
               </div>
            </div>
          </div>

          <button
            onClick={startPvcGame}
            className="w-full flex items-center justify-center gap-2 bg-[#e4e4e7] hover:bg-[#d4d4d8] text-[#09090b] p-3 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition"
          >
            <Play className="w-4 h-4" />
            Start Game
          </button>
        </div>
      )
    }

    if (gameMode === "p2p" && connState === "disconnected") {
      return (
        <div className="flex flex-col w-full h-full justify-center">
          <button onClick={exitToMenu} className="self-start flex items-center tracking-[1px] text-[10px] uppercase text-[#71717a] hover:text-[#a1a1aa] font-bold mb-6">
             <ChevronLeft className="w-3 h-3 mr-1" /> Back
          </button>
          
          <div className="text-center space-y-2 mb-8">
            <MonitorPlay className="mx-auto w-10 h-10 text-[#52525b]" />
            <h1 className="text-[12px] font-bold tracking-[2px] uppercase text-[#e4e4e7]">P2P Multiplayer</h1>
            <p className="text-[#a1a1aa] text-[12px] mt-2">Play via WebRTC directly between browsers.</p>
          </div>

          <button
            onClick={initHost}
            className="w-full flex items-center justify-center gap-2 bg-[#e4e4e7] hover:bg-[#d4d4d8] text-[#09090b] p-3 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition mb-4"
          >
            <QrCode className="w-4 h-4" />
            Host a Game
          </button>
          
          <div className="relative flex justify-center text-[10px] tracking-[1px] mb-4">
            <span className="w-full border-t border-[#27272a] absolute top-1/2 -mt-px relative" />
            <span className="bg-[#111113] px-2 text-[#52525b] absolute">OR</span>
          </div>

          <button
            onClick={initJoin}
            className="w-full flex items-center justify-center gap-2 bg-[#27272a] hover:bg-[#3f3f46] text-[#e4e4e7] border border-[#27272a] p-3 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition"
          >
            <ScanQrCode className="w-4 h-4" />
            Join a Game
          </button>
        </div>
      );
    }

    if (gameMode === "p2p" && connState === "hosting") {
      return (
        <div className="flex flex-col w-full">
          <button onClick={exitToMenu} className="self-start flex items-center tracking-[1px] text-[10px] uppercase text-[#71717a] hover:text-[#a1a1aa] font-bold mb-4">
             <ChevronLeft className="w-3 h-3 mr-1" /> Back
          </button>
          
          <h2 className="text-[10px] uppercase tracking-[1px] text-[#e4e4e7] font-bold mb-1">1. Share Offer Code</h2>
          <p className="text-[10px] text-[#71717a] mb-4">Send this code (or scan the QR) to player 2.</p>
          
          {isGenerating ? (
              <div className="animate-pulse bg-[#18181b] h-32 rounded-sm flex items-center justify-center text-[#52525b] text-[10px] tracking-[1px] uppercase">
                  Generating codes...
              </div>
          ) : (
            <>
               <div className="flex justify-center bg-[#e4e4e7] p-4 rounded-sm shadow-sm mb-4">
                   {localCode && <QRCodeSVG value={localCode} size={200} level="L" />}
               </div>
               <div className="flex items-center gap-2 mb-6">
                 <input
                   readOnly
                   value={localCode}
                   className="flex-1 bg-[#0a0a0b] border border-[#27272a] p-2 text-[10px] font-mono text-[#71717a] rounded-sm"
                 />
                 <button 
                  onClick={() => navigator.clipboard.writeText(localCode)}
                  className="bg-[#27272a] p-2 rounded-sm hover:bg-[#3f3f46] transition text-[#a1a1aa]"
                  title="Copy"
                 >
                   <Copy className="w-4 h-4" />
                 </button>
               </div>

               <h2 className="text-[10px] uppercase tracking-[1px] text-[#e4e4e7] font-bold mt-2 mb-1">2. Enter Answer Code</h2>
               <p className="text-[10px] text-[#71717a] mb-3">Paste player 2's answer code below or scan their QR.</p>
               
               {showScanner ? (
                   <div className="relative rounded-sm overflow-hidden border border-[#27272a] mb-3">
                       <button onClick={() => setShowScanner(false)} className="absolute top-2 right-2 z-10 bg-[#09090b]/80 text-[#e4e4e7] p-1.5 rounded-sm"><X className="w-3 h-3"/></button>
                       <Scanner
                           onScan={(result) => {
                               if (result && result.length > 0) {
                                   setRemoteCodeInput(result[0].rawValue);
                                   setShowScanner(false);
                                   acceptAnswerCode(result[0].rawValue);
                               }
                           }}
                           onError={(error) => console.log(error)}
                       />
                   </div>
               ) : (
                   <div className="flex gap-2 mb-3">
                       <input
                           value={remoteCodeInput}
                           onChange={(e) => setRemoteCodeInput(e.target.value)}
                           className="flex-1 bg-[#0a0a0b] border border-[#27272a] p-2 text-[10px] font-mono text-[#e4e4e7] rounded-sm placeholder-[#52525b]"
                           placeholder="Paste answer code..."
                       />
                       <button onClick={() => setShowScanner(true)} className="bg-[#27272a] p-2 rounded-sm hover:bg-[#3f3f46] transition text-[#a1a1aa]">
                           <ScanQrCode className="w-4 h-4" />
                       </button>
                   </div>
               )}
               
               <button
                  onClick={() => acceptAnswerCode(remoteCodeInput)}
                  disabled={!remoteCodeInput}
                  className="w-full bg-[#e4e4e7] text-[#09090b] p-2.5 text-[11px] font-bold uppercase tracking-[1px] rounded-sm transition hover:bg-[#d4d4d8] disabled:opacity-50 mt-2"
               >
                  Connect
               </button>
            </>
          )}
        </div>
      );
    }

    if (gameMode === "p2p" && connState === "joining") {
      return (
        <div className="flex flex-col w-full">
          <button onClick={exitToMenu} className="self-start flex items-center tracking-[1px] text-[10px] uppercase text-[#71717a] hover:text-[#a1a1aa] font-bold mb-4">
             <ChevronLeft className="w-3 h-3 mr-1" /> Back
          </button>
          
          <h2 className="text-[10px] uppercase tracking-[1px] text-[#e4e4e7] font-bold mb-1">1. Enter Offer Code</h2>
          <p className="text-[10px] text-[#71717a] mb-3">Paste player 1's offer code below or scan their QR.</p>

          {showScanner ? (
            <div className="relative rounded-sm overflow-hidden border border-[#27272a] mb-3">
                <button onClick={() => setShowScanner(false)} className="absolute top-2 right-2 z-10 bg-[#09090b]/80 text-[#e4e4e7] p-1.5 rounded-sm"><X className="w-3 h-3"/></button>
                <Scanner
                    onScan={(result) => {
                        if (result && result.length > 0) {
                            setRemoteCodeInput(result[0].rawValue);
                            setShowScanner(false);
                        }
                    }}
                    onError={(error) => console.log(error)}
                />
            </div>
          ) : (
            <div className="flex gap-2 mb-4">
                <input
                    value={remoteCodeInput}
                    onChange={(e) => setRemoteCodeInput(e.target.value)}
                    className="flex-1 bg-[#0a0a0b] border border-[#27272a] p-2 text-[10px] font-mono text-[#e4e4e7] rounded-sm placeholder-[#52525b]"
                    placeholder="Paste offer code..."
                />
                <button onClick={() => setShowScanner(true)} className="bg-[#27272a] p-2 rounded-sm hover:bg-[#3f3f46] transition text-[#a1a1aa]">
                    <ScanQrCode className="w-4 h-4" />
                </button>
            </div>
          )}

          <button
              onClick={() => generateAnswerCode(remoteCodeInput)}
              disabled={!remoteCodeInput || isGenerating || !!localCode}
              className="w-full bg-[#e4e4e7] text-[#09090b] p-2.5 text-[11px] font-bold uppercase tracking-[1px] rounded-sm transition hover:bg-[#d4d4d8] disabled:opacity-50"
          >
              {isGenerating ? "Processing..." : "Generate Answer Code"}
          </button>

          {localCode && (
              <div className="mt-6 flex flex-col animate-in fade-in slide-in-from-bottom-4">
                 <div className="w-full h-px bg-[#27272a] mb-4"></div>
                 <h2 className="text-[10px] uppercase tracking-[1px] text-[#e4e4e7] font-bold mt-2 mb-1">2. Share Answer Code</h2>
                 <p className="text-[10px] text-[#71717a] mb-3">Send this back to player 1 so they can connect.</p>
                 
                 <div className="flex justify-center bg-[#e4e4e7] p-4 rounded-sm shadow-sm mb-3">
                     <QRCodeSVG value={localCode} size={200} level="L" />
                 </div>
                 <div className="flex items-center gap-2 mb-2">
                   <input
                     readOnly
                     value={localCode}
                     className="flex-1 bg-[#0a0a0b] border border-[#27272a] p-2 text-[10px] font-mono text-[#71717a] rounded-sm"
                   />
                   <button 
                    onClick={() => navigator.clipboard.writeText(localCode)}
                    className="bg-[#27272a] p-2 rounded-sm hover:bg-[#3f3f46] transition text-[#a1a1aa]"
                   >
                     <Copy className="w-4 h-4" />
                   </button>
                 </div>
                 <div className="text-center text-[10px] text-[#52525b] mt-2 tracking-[1px] uppercase">Waiting for player 1...</div>
              </div>
          )}
        </div>
      );
    }

    // Active playing state
    if (gameMode === "local_pvp" || gameMode === "local_pvc" || (gameMode === "p2p" && connState === "connected")) {
      return (
        <div className="flex flex-col gap-6 h-full">
            <button onClick={exitToMenu} className="self-start flex items-center tracking-[1px] text-[10px] uppercase text-[#71717a] hover:text-[#a1a1aa] font-bold">
               <ChevronLeft className="w-3 h-3 mr-1" /> Exit
            </button>
            <div>
                <div className="text-[10px] uppercase tracking-[1px] text-[#52525b] mb-4 font-bold">Game Intelligence</div>
                
                <div className="space-y-3">
                    {gameMode === "p2p" && (
                        <div className="flex justify-between items-center bg-[#0a0a0b] p-3 rounded-sm border border-[#18181b]">
                            <span className="text-[10px] uppercase tracking-[1px] font-bold text-[#71717a]">Playing As</span>
                            <div className="flex items-center gap-2">
                                <div className={cn("w-3 h-3 rounded-full border", playerColor === 'w' ? 'bg-[#f4f4f5] border-[#a1a1aa]' : 'bg-[#18181b] border-[#52525b]')} />
                                <span className="text-[10px] font-bold text-[#e4e4e7] uppercase tracking-[1px]">{playerColor === 'w' ? 'White' : 'Black'}</span>
                            </div>
                        </div>
                    )}

                    {gameMode === "local_pvc" && (
                        <>
                           <div className="flex justify-between items-center bg-[#0a0a0b] p-3 rounded-sm border border-[#18181b]">
                               <span className="flex items-center gap-2 text-[10px] uppercase tracking-[1px] font-bold text-[#e4e4e7]">
                                  <div className={cn("w-3 h-3 rounded-full border", playerColor === 'w' ? 'bg-[#f4f4f5] border-[#a1a1aa]' : 'bg-[#18181b] border-[#52525b]')} />
                                  {playerUsername}
                               </span>
                           </div>
                           <div className="text-center text-[10px] font-bold uppercase tracking-[1px] text-[#52525b]">VS</div>
                           <div className="flex flex-col bg-[#0a0a0b] p-3 rounded-sm border border-[#18181b] gap-1">
                               <div className="flex justify-between items-center w-full">
                                   <span className="flex items-center gap-2 text-[10px] uppercase tracking-[1px] font-bold text-[#e4e4e7]">
                                      <div className={cn("w-3 h-3 rounded-full border", playerColor !== 'w' ? 'bg-[#f4f4f5] border-[#a1a1aa]' : 'bg-[#18181b] border-[#52525b]')} />
                                      {computerUsername}
                                   </span>
                                   <Bot className="w-4 h-4 text-[#71717a]" />
                               </div>
                               <div className="text-[10px] text-[#71717a] ml-5">{ELO_LEVELS.find(l => l.level === computerEloLevel)?.label}</div>
                           </div>
                        </>
                    )}
                    
                    <div className="flex justify-between items-center bg-[#0a0a0b] p-3 rounded-sm border border-[#18181b]">
                        <span className="text-[10px] uppercase tracking-[1px] font-bold text-[#71717a]">Turn</span>
                        <span className={cn("text-[10px] font-bold uppercase tracking-[1px]", game.isGameOver() ? 'text-[#52525b]' : 'text-[#a1a1aa]')}>
                            {game.isGameOver() 
                              ? "Game Over" 
                              : gameMode === "local_pvp"
                                ? (game.turn() === "w" ? "White's Turn" : "Black's Turn")
                                : (game.turn() === playerColor ? "Your Turn" : "Opponent's")}
                        </span>
                    </div>
                </div>
            </div>

            {game.isGameOver() && (
                <div className="bg-[#18181b] text-[#e4e4e7] p-4 rounded-sm border border-[#27272a] mt-auto">
                    <p className="text-[11px] uppercase tracking-[1px] font-bold text-[#f4f4f5] mb-2">Game Over!</p>
                    <p className="text-[10px] text-[#a1a1aa] mb-4">
                        {game.isCheckmate() ? "Checkmate!" :
                         game.isDraw() ? "Draw!" :
                         game.isStalemate() ? "Stalemate!" :
                         "Ended"}
                    </p>
                    <button
                       onClick={startNewGame}
                       className="w-full bg-[#e4e4e7] text-[#09090b] text-[11px] font-bold uppercase tracking-[1px] p-2.5 rounded-sm transition hover:bg-[#d4d4d8]"
                    >
                       Start New Game
                    </button>
                </div>
            )}

            {statusMessage && gameMode === "p2p" && (
                <div className="text-[10px] text-[#71717a] font-mono border-l-2 border-[#52525b] pl-3 py-1 mt-auto">
                    {statusMessage}
                </div>
            )}
        </div>
      );
    }

    return null;
  };

  const turn = game.turn();

  const onPieceDrag = useCallback((args: any) => {
    const square = typeof args === 'object' && args !== null ? args.square : args;
    if (!square || game.isGameOver()) return;
    const sq = square as Square;
    if (game.get(sq) && game.get(sq)?.color === game.turn()) {
        const hasOptions = getMoveOptions(sq);
        if (hasOptions) setMoveFrom(sq);
    }
  }, [game, getMoveOptions]);

  const activeSquareStyles = useMemo(() => {
    let styles: any = { ...optionSquares };
    if (game.inCheck()) {
      const boardState = game.board();
      for (const row of boardState) {
        for (const p of row) {
          if (p && p.type === 'k' && p.color === game.turn()) {
            styles[p.square] = {
              ...styles[p.square],
              background: "radial-gradient(circle, rgba(239, 68, 68, 0.8) 20%, transparent 20%)",
            };
          }
        }
      }
    }
    return styles;
  }, [game, optionSquares]);

  const cbOptions = useMemo(() => ({
    id: `chessboard-${boardPreset.id}`,
    position: fen,
    onPieceDrop: (args: any) => handleDrop({ sourceSquare: args?.sourceSquare, targetSquare: args?.targetSquare, piece: args?.piece && typeof args.piece === 'object' ? args.piece.pieceType : args?.piece }),
    onSquareClick: handleSquareClick,
    onPieceClick: (args: any) => {
        const square = typeof args === 'object' && args !== null ? args.square : args;
        if (!square || game.isGameOver()) return;
        const sq = square as Square;
        if (game.get(sq) && game.get(sq)?.color === game.turn()) {
            const hasOptions = getMoveOptions(sq);
            if (hasOptions) setMoveFrom(sq);
        }
    },
    onPieceDrag: onPieceDrag,
    squareStyles: activeSquareStyles,
    arrows: showAnalyzer && bestMove && bestMove.length >= 4 
      ? [{ startSquare: bestMove.substring(0, 2), endSquare: bestMove.substring(2, 4), color: "rgba(255, 170, 0, 0.8)" }] 
      : undefined,
    boardStyle: { gridTemplateRows: 'repeat(8, 1fr)' },
    boardOrientation: (gameMode === "local_pvp" ? (turn === "w" ? "white" : "black") : (playerColor === "w" ? "white" : "black")) as "white" | "black",
    darkSquareStyle: { backgroundColor: boardPreset.dark },
    lightSquareStyle: { backgroundColor: boardPreset.light },
    lightSquareNotationStyle: { color: boardPreset.dark },
    darkSquareNotationStyle: { color: boardPreset.light },
    animationDurationInMs: 300,
    showNotation: true
  }), [fen, boardPreset, handleSquareClick, handleDrop, onPieceClick, onPieceDrag, activeSquareStyles, gameMode, turn, playerColor, game]);

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-[#e4e4e7] font-sans selection:bg-[#27272a] pb-12">
       <header className="border-b border-[#27272a] sticky top-0 z-10 px-10 py-5 flex items-center justify-between bg-[#0a0a0b]">
           <div className="text-[14px] font-bold tracking-[4px] uppercase text-[#a1a1aa] flex items-center gap-2">
             <Swords className="w-6 h-6 text-[#52525b]" />
             Chess Playground
           </div>

           {connState === "connected" && gameMode === "p2p" ? (
             <div className="flex items-center gap-3">
                 <div className="bg-[#18181b] px-3 py-1.5 rounded-[100px] text-[10px] font-bold tracking-[1px] uppercase border border-[#27272a] text-[#71717a] flex items-center gap-2">
                    <span className="flex h-2 w-2 relative">
                       <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                       <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                    </span>
                    Connected
                 </div>
                 <button
                   onClick={startNewGame}
                   className="bg-[#27272a] text-[#e4e4e7] hover:bg-[#3f3f46] px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-[1px] transition"
                 >
                   New Game
                 </button>
                 <button
                   onClick={exitToMenu}
                   className="bg-[#18181b] text-red-400 hover:text-red-300 border border-[#27272a] px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-[1px] transition"
                 >
                   Disconnect
                 </button>
                 <button
                   onClick={handleDownloadStandaloneHtml}
                   disabled={downloading}
                   className="bg-[#18181b] hover:bg-[#27272a] text-[#e4e4e7] border border-[#27272a] px-2.5 py-1.5 rounded-sm transition flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-[1px]"
                   title="Download Standalone Single HTML"
                 >
                   <Download className="w-3.5 h-3.5 text-emerald-400" />
                   <span className="hidden md:inline">{downloading ? 'Saving...' : 'Single HTML'}</span>
                 </button>
                 <button
                   onClick={() => setShowSettings(!showSettings)}
                   className="bg-[#18181b] text-[#71717a] hover:text-[#e4e4e7] border border-[#27272a] p-1.5 rounded-sm transition flex items-center"
                   title="Board Settings"
                 >
                   <Palette className="w-4 h-4" />
                 </button>
             </div>
           ) : (
              <div className="flex items-center gap-2 sm:gap-3">
                 <button
                   onClick={handleDownloadStandaloneHtml}
                   disabled={downloading}
                   className="bg-[#18181b] hover:bg-[#27272a] text-[#e4e4e7] border border-[#27272a] px-3 py-1.5 rounded-sm transition flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-[1px]"
                   title="Download Standalone Single HTML File"
                 >
                   <Download className="w-3.5 h-3.5 text-emerald-400" />
                   <span className="hidden sm:inline">{downloading ? 'Saving...' : 'Single HTML'}</span>
                 </button>
                 <button
                   onClick={() => setShowSettings(!showSettings)}
                   className="bg-[#18181b] text-[#71717a] hover:text-[#e4e4e7] border border-[#27272a] p-1.5 rounded-sm transition flex items-center gap-2 text-[10px] uppercase font-bold tracking-[1px]"
                   title="Board Settings"
                 >
                   <Palette className="w-4 h-4" />
                   <span className="hidden sm:inline">Theme</span>
                 </button>
              </div>
           )}
       </header>

       <main className="max-w-6xl mx-auto px-10 mt-10 flex flex-col md:flex-row gap-8 items-start justify-center relative">
         
         {showSettings && (
             <div className="absolute top-0 right-10 z-20 w-[240px] bg-[#111113] border border-[#27272a] rounded-sm p-4 shadow-xl">
                 <div className="flex justify-between items-center mb-4">
                     <span className="text-[10px] font-bold uppercase tracking-[1px] text-[#e4e4e7]">Board Theme</span>
                     <button onClick={() => setShowSettings(false)} className="text-[#a1a1aa] hover:text-[#e4e4e7]">
                         <X className="w-3 h-3" />
                     </button>
                 </div>
                 <div className="flex flex-col gap-2">
                     {BOARD_PRESETS.map((preset) => (
                         <button
                           key={preset.id}
                           onClick={() => setBoardPreset(preset)}
                           className={cn(
                             "flex items-center gap-3 p-2 rounded-sm border transition",
                             boardPreset.id === preset.id 
                                ? "bg-[#27272a] border-[#3f3f46] text-[#e4e4e7]" 
                                : "bg-[#18181b] border-[#27272a] text-[#71717a] hover:bg-[#27272a]"
                           )}
                         >
                             <div className="w-4 h-4 rounded-sm border border-[#3f3f46] flex overflow-hidden shrink-0">
                                 <div className="w-1/2 h-full" style={{ backgroundColor: preset.light }} />
                                 <div className="w-1/2 h-full" style={{ backgroundColor: preset.dark }} />
                             </div>
                             <span className="text-[10px] font-bold uppercase tracking-[1px] text-left">{preset.name}</span>
                         </button>
                     ))}
                 </div>
                 <div className="w-full h-px bg-[#27272a] my-4"></div>
                 <div className="flex items-center justify-between">
                     <span className="text-[10px] font-bold uppercase tracking-[1px] text-[#e4e4e7] flex items-center gap-2">
                         <Activity className="w-3 h-3" />
                         Analyzer
                     </span>
                     <button 
                         onClick={() => setShowAnalyzer(!showAnalyzer)}
                         className={cn(
                             "w-10 h-5 rounded-full relative transition border",
                             showAnalyzer ? "bg-green-500/20 border-green-500/50" : "bg-[#18181b] border-[#27272a]"
                         )}
                     >
                         <div className={cn(
                             "w-3 h-3 rounded-full absolute top-1/2 -translate-y-1/2 transition-all",
                             showAnalyzer ? "bg-green-400 left-[22px]" : "bg-[#a1a1aa] left-[5px]"
                         )} />
                     </button>
                 </div>
             </div>
         )}
         
         <div className="flex-1 w-full flex justify-center max-w-[512px] relative">
             <div className="flex w-full">
                 {showAnalyzer && (
                     <EvaluationBar evaluation={evaluation} mate={mate} turn={game.turn()} />
                 )}
                 <div className="w-full rounded-sm border border-[#18181b] bg-[#111113] relative" style={{ paddingBottom: '100%' }}>
                     <div className="absolute inset-0 w-full h-full overflow-hidden">
                         <ErrorBoundary>
                           <Chessboard options={cbOptions} />
                         </ErrorBoundary>
                     </div>
                 </div>
             </div>
                  
                  {gameMode !== "menu" && !(gameMode === "local_pvc" && isPvcSetup) && game.isGameOver() && (
                      <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center p-6 text-center z-20 backdrop-blur-[2px]">
                          <h2 className="text-3xl font-bold text-white mb-2 tracking-tight">
                            {game.isCheckmate() ? "Checkmate!" : game.isDraw() ? "Draw" : "Game Over"}
                          </h2>
                          <p className="text-[#a1a1aa] mb-8 font-medium">
                            {game.isCheckmate() ? (game.turn() === 'w' ? 'Black wins' : 'White wins') : 'The game ended in a draw.'}
                          </p>
                          <div className="flex flex-col gap-3 w-full max-w-[200px]">
                              <button 
                                onClick={startNewGame} 
                                className="w-full flex items-center justify-center gap-2 bg-white hover:bg-gray-200 text-black p-3 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition"
                              >
                                Play Again
                              </button>
                              {gameMode === "local_pvc" && (
                                <button 
                                  onClick={() => setIsPvcSetup(true)} 
                                  className="w-full flex items-center justify-center gap-2 bg-[#27272a] hover:bg-[#3f3f46] text-[#e4e4e7] border border-[#27272a] p-3 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition"
                                >
                                  Choose Another Bot
                                </button>
                              )}
                              <button 
                                onClick={exitToMenu} 
                                className="w-full flex items-center justify-center gap-2 bg-[#18181b] hover:bg-[#27272a] text-[#a1a1aa] border border-[#27272a] p-3 rounded-sm font-bold text-[11px] uppercase tracking-[1px] transition"
                              >
                                Main Menu
                              </button>
                          </div>
                      </div>
                  )}
         </div>

         <div className="w-full md:w-[350px] shrink-0 bg-[#111113] border border-[#27272a] p-6 rounded-[4px] min-h-[512px] flex flex-col">
             {renderSidebarPanel()}
         </div>

       </main>
    </div>
  );
}
