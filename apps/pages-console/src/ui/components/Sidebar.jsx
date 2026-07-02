import { KeyRound, Settings, UsersRound, Workflow } from 'lucide-react';
import { Link } from 'react-router-dom';

export function Sidebar({ active }) {
  return (
    <aside className="sidebar">
      <nav className="side-section" aria-label="工作台导航">
        <p className="side-title">站点</p>
        <Link className={active === 'personal' ? 'side-link active' : 'side-link'} to="/workspace/published">
          <Workflow size={17} />
          <span>个人站点</span>
        </Link>
        <Link className={active === 'team-sites' ? 'side-link active' : 'side-link'} to="/workspace/team-sites">
          <Workflow size={17} />
          <span>团队站点</span>
        </Link>
      </nav>
      <nav className="side-section" aria-label="协作导航">
        <p className="side-title">协作</p>
        <Link className={active === 'teams' ? 'side-link active' : 'side-link'} to="/workspace/teams">
          <UsersRound size={17} />
          <span>团队</span>
        </Link>
      </nav>
      <nav className="side-section" aria-label="设置导航">
        <p className="side-title">设置</p>
        <Link className={active === 'access-keys' ? 'side-link active' : 'side-link'} to="/workspace/access-keys">
          <KeyRound size={17} />
          <span>Access Keys</span>
        </Link>
        <Link className={active === 'settings' ? 'side-link active' : 'side-link'} to="/workspace/settings">
          <Settings size={17} />
          <span>账号设置</span>
        </Link>
      </nav>
    </aside>
  );
}
