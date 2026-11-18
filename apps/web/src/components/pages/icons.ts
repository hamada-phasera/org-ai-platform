import {
  BarChart3,
  Bell,
  Briefcase,
  Building,
  Calendar,
  CheckSquare,
  ClipboardList,
  Clock,
  FileText,
  Folder,
  Hammer,
  Inbox,
  Mail,
  MapPin,
  MessageCircle,
  Package,
  Phone,
  Receipt,
  ShoppingCart,
  Star,
  Truck,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isPageIcon, type PageIcon } from '@org-ai/shared-types';

/**
 * ページのアイコン名（shared-types の許可リスト）→ lucide のコンポーネント。
 * 静的な表（動的 import しない）。`Record<PageIcon, …>` なので許可リストに足したら型エラーで気づく。
 */
export const PAGE_ICON_COMPONENTS: Record<PageIcon, LucideIcon> = {
  'file-text': FileText,
  inbox: Inbox,
  users: Users,
  calendar: Calendar,
  truck: Truck,
  hammer: Hammer,
  'clipboard-list': ClipboardList,
  phone: Phone,
  mail: Mail,
  package: Package,
  wallet: Wallet,
  'chart-bar': BarChart3,
  building: Building,
  'map-pin': MapPin,
  wrench: Wrench,
  'shopping-cart': ShoppingCart,
  star: Star,
  bell: Bell,
  folder: Folder,
  clock: Clock,
  'check-square': CheckSquare,
  'message-circle': MessageCircle,
  briefcase: Briefcase,
  receipt: Receipt,
};

/** 知らない名前（古い web と新しい許可リスト）は既定のアイコン */
export function pageIconOf(name: unknown): LucideIcon {
  return isPageIcon(name) ? PAGE_ICON_COMPONENTS[name] : FileText;
}
