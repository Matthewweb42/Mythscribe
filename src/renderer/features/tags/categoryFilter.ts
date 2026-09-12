import { TAG_CATEGORIES, TAG_CATEGORY_LABEL, type TagCategory } from '@shared/tags'

/** The category strip's value (F-4.2): a real category, or every tag. "all" never reaches main. */
export type CategoryFilter = TagCategory | 'all'

/** The strip's entries in display order: All, then the categories in spec order. */
export const CATEGORY_FILTERS: readonly CategoryFilter[] = ['all', ...TAG_CATEGORIES]

export const filterLabel = (filter: CategoryFilter): string =>
  filter === 'all' ? 'All' : TAG_CATEGORY_LABEL[filter]

/** The category a new tag gets under a filter: the filter itself, or Custom under "All". */
export const defaultCategoryFor = (filter: CategoryFilter): TagCategory =>
  filter === 'all' ? 'custom' : filter
