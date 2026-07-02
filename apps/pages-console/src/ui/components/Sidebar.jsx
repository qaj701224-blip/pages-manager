import { KeyRound, Settings, UsersRound, Workflow } from 'lucide-react';

export function Sidebar({ active }) {
  return (
    <aside className="sidebar">
      <nav className="side-section" aria-label="工作台导航">
        <p className="side-title">站点</p>
        <a className={active === 'personal' ? 'side-link active' : 'side-link'} href="/workspace/published">
          <Workflow size={17} />
          <span>个人站点</span>
        </a>
        <a className={active === 'team-sites' ? 'side-link active' : 'side-link'} href="/workspace/team-sites">
          <Workflow size={17} />
          <span>团队站点</span>
        </a>
      </nav>
      <nav className="side-section" aria-label="协作导航">
        <p className="side-title">协作</p>
        <a className={active === 'teams' ? 'side-link active' : 'side-link'} href="/workspace/teams">
          <UsersRound size={17} />
          <span>团队</span>
        </a>
      </nav>
      <nav className="side-section" aria-label="设置导航">
        <p className="side-title">设置</p>
        <a className={active === 'access-keys' ? 'side-link active' : 'side-link'} href="/workspace/access-keys">
          <KeyRound size={17} />
          <span>Access Keys</span>
        </a>
        <a className={active === 'settings' ? 'side-link active' : 'side-link'} href="/workspace/settings">
          <Settings size={17} />
          <span>账号设置</span>
        </a>
      </nav>
    </aside>
  );
}
