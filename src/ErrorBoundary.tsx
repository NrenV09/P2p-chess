import React, { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: ""
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error.message };
  }

  public componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.warn("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="w-full aspect-square flex items-center justify-center bg-[#111113] border border-[#18181b] text-red-500 p-4 text-center rounded-sm">
          <div>
            <h1 className="font-bold mb-2">Chessboard Error</h1>
            <p className="text-[10px] text-[#a1a1aa]">{this.state.errorMessage}</p>
            <button 
              onClick={() => this.setState({ hasError: false })}
              className="mt-4 px-3 py-1 bg-[#27272a] text-[#e4e4e7] rounded-sm text-[10px] uppercase font-bold tracking-[1px] hover:bg-[#3f3f46]"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
