import { QueryClient } from '@tanstack/react-query';

/** アプリ全体で1つ。組織を切り替えたら clear() する（services/session.ts） */
export const queryClient = new QueryClient();
