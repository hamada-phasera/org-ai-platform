export interface Agent {
  id: string;
  department: string;
  name: string;
  color: string;
  colorLight: string;
  icon: string;
  personality: string;
  image: string;
  rating: number;
  status: 'active' | 'processing' | 'idle';
  taskCount: number;
  description: string;
  latestReport: string;
  rank: number;
  rankLabel: string;
}
