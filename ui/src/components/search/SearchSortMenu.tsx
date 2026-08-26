import { ArrowUpDown, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { COMPANY_SEARCH_SORTS, type CompanySearchSort } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function SearchSortMenu({
  value,
  onChange,
}: {
  value: CompanySearchSort;
  onChange: (next: CompanySearchSort) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs font-normal" aria-label={t("search.filters.sortResults")}>
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="hidden sm:inline text-muted-foreground">{t("search.filters.sort")}:</span>
          <span>{t(`search.sort.${value}`)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("search.filters.sortBy")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {COMPANY_SEARCH_SORTS.map((sort) => (
          <DropdownMenuItem key={sort} onSelect={() => onChange(sort)} className="gap-2 text-sm">
            <Check className={cn("h-3.5 w-3.5", sort === value ? "opacity-100 text-primary" : "opacity-0")} />
            {t(`search.sort.${sort}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
