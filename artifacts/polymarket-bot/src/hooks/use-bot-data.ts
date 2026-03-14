import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetBotStatus, 
  useGetMarketAnalysis, 
  useGetBtcPrice,
  useGetTrades,
  useStartBot,
  useStopBot,
  useResetBot,
  getGetBotStatusQueryKey,
  getGetTradesQueryKey
} from "@workspace/api-client-react";

// Wrap generated hooks to add polling logic
export function useBotPolling() {
  const queryClient = useQueryClient();

  // 1. Poll bot status every 3 seconds always to know if it's running
  const statusQuery = useGetBotStatus({
    query: {
      refetchInterval: 3000,
      staleTime: 2000,
    }
  });

  const isRunning = statusQuery.data?.running === true;

  // 2. Poll market analysis every 5s only if running, otherwise every 15s to keep UI alive
  const analysisQuery = useGetMarketAnalysis({
    query: {
      refetchInterval: isRunning ? 5000 : 15000,
      staleTime: 4000,
    }
  });

  // 3. Poll BTC price every 10s regardless
  const btcQuery = useGetBtcPrice({
    query: {
      refetchInterval: 10000,
      staleTime: 9000,
    }
  });

  // 4. Poll trades occasionally, or invalidate on actions
  const tradesQuery = useGetTrades(
    { limit: 50, offset: 0 }, 
    {
      query: {
        refetchInterval: isRunning ? 5000 : false,
      }
    }
  );

  // Mutations
  const startMutation = useStartBot({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTradesQueryKey() });
      }
    }
  });

  const stopMutation = useStopBot({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }
    }
  });

  const resetMutation = useResetBot({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTradesQueryKey() });
      }
    }
  });

  return {
    status: statusQuery,
    analysis: analysisQuery,
    btc: btcQuery,
    trades: tradesQuery,
    mutations: {
      start: startMutation,
      stop: stopMutation,
      reset: resetMutation
    }
  };
}
