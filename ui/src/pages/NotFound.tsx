import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="page-heading">Not found</h1>
      <Link to="/" className="btn btn-ghost mt-5">
        Back to jobs
      </Link>
    </div>
  );
}
