import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale/zh-CN';
import { convertUTCToLocal } from './dateUtils';
import { currentUiLanguage } from '../../src/utils/i18n';

/** "3 hours ago", or "3 小时前" in Chinese. */
export function formatTimeAgo(utcDateString: string): string {
    const localDate = convertUTCToLocal(utcDateString);
    return formatDistanceToNow(localDate, {
        addSuffix: true,
        ...(currentUiLanguage() === 'zh-CN' ? { locale: zhCN } : {}),
    });
}
