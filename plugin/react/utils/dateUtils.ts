import { format, isToday, isYesterday, isThisWeek, isThisMonth, parseISO } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { zhCN } from 'date-fns/locale/zh-CN';
import { currentUiLanguage, msg, t } from '../../src/utils/i18n';

// Re-export date-fns functions
export { isToday, isYesterday, isThisWeek, isThisMonth };

/**
 * Converts a UTC date string to a local Date object
 * @param utcDateString - UTC date string (ISO format)
 * @returns Date object in local timezone
 */
export function convertUTCToLocal(dateString: string): Date {
    // Handle both ISO strings and other date formats
    let date: Date;
    try {
        date = parseISO(dateString);
        // Check if valid date was parsed
        if (isNaN(date.getTime())) {
            // Fallback to regular Date constructor
            date = new Date(dateString);
        }
    } catch (error) {
        // Fallback to regular Date constructor
        date = new Date(dateString);
    }

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return toZonedTime(date, timeZone);
}

/**
 * Formats a date relative to the current time
 * @param date - Date object
 * @returns Formatted string
 */
export function formatRelativeDate(date: Date) {
    const chinese = currentUiLanguage() === 'zh-CN';
    const time = format(date, chinese ? 'HH:mm' : 'h:mma');
    if (isToday(date)) {
        return t('Today at {time}', { time });
    } else if (isYesterday(date)) {
        return t('Yesterday at {time}', { time });
    } else if (isThisWeek(date)) {
        const weekday = chinese ? format(date, 'EEEE', { locale: zhCN }) : format(date, 'EEEE');
        return t('{weekday} at {time}', { weekday, time });
    } else {
        return chinese ? format(date, 'yyyy年M月d日') : format(date, 'MMM d, yyyy');
    }
}

/**
 * Groups a thread based on its creation date
 * @param dateString - UTC date string
 * @returns The group name ('Today', 'Yesterday', etc.), in English; shown through `t`
 */
export function getDateGroup(dateString: string): string {
    const date = convertUTCToLocal(dateString);
    
    if (isToday(date)) {
        return msg('Today');
    } else if (isYesterday(date)) {
        return msg('Yesterday');
    } else if (isThisWeek(date)) {
        return msg('This Week');
    } else if (isThisMonth(date)) {
        return msg('This Month');
    } else {
        return msg('Older');
    }
}