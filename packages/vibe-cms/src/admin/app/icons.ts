import {
  BookOpenIcon, BoxIcon, BriefcaseIcon, BuildingIcon, CalendarIcon, ChartBarIcon, FileIcon, FileTextIcon, FilmIcon,
  FolderIcon, GlobeIcon, HeartIcon, HomeIcon, ImageIcon, InboxIcon, LayersIcon, LayoutIcon, LinkIcon, MailIcon, MapPinIcon,
  MegaphoneIcon, MenuIcon, MessageSquareIcon, MusicIcon, NewspaperIcon, PackageIcon, PaletteIcon, QuoteIcon, SearchIcon,
  SettingsIcon, ShoppingBagIcon, SparklesIcon, StarIcon, TagIcon, UserIcon, UserRoundIcon, UsersIcon, WrenchIcon,
  type LucideIcon
} from "lucide-react";

/** Icon names accepted by `collections.<type>.icon` and plugin nav items. */
export const navIcons: Record<string, LucideIcon> = {
  "book-open": BookOpenIcon, box: BoxIcon, briefcase: BriefcaseIcon, building: BuildingIcon, calendar: CalendarIcon,
  "chart-bar": ChartBarIcon, file: FileIcon, "file-text": FileTextIcon, film: FilmIcon, folder: FolderIcon, globe: GlobeIcon,
  heart: HeartIcon, home: HomeIcon, image: ImageIcon, inbox: InboxIcon, layers: LayersIcon, layout: LayoutIcon, link: LinkIcon,
  mail: MailIcon, "map-pin": MapPinIcon, megaphone: MegaphoneIcon, menu: MenuIcon, "message-square": MessageSquareIcon,
  music: MusicIcon, newspaper: NewspaperIcon, package: PackageIcon, palette: PaletteIcon, quote: QuoteIcon, search: SearchIcon,
  settings: SettingsIcon, "shopping-bag": ShoppingBagIcon, sparkles: SparklesIcon, star: StarIcon, tag: TagIcon, user: UserIcon,
  "user-round": UserRoundIcon, users: UsersIcon, wrench: WrenchIcon
};
